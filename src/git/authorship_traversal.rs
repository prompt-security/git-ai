use std::collections::HashSet;
use std::path::PathBuf;

use crate::{error::GitAiError, git::repository::Repository};
use gix_object::Find;

/// Get a HashSet of all files that have AI attributions across all commits
///
/// Efficiently loads all notes and extracts unique file paths without keeping
/// full attestations in memory
pub async fn load_all_ai_touched_files(repo: &Repository) -> Result<HashSet<String>, GitAiError> {
    let git_dir = repo.path().to_path_buf();

    // Open repo and collect blob entries (sync part)
    let (repo_path, blob_entries) = smol::unblock(move || {
        // Find the .git directory

        // Open the object database
        let mut odb = gix_odb::at(git_dir.join("objects"))
            .map_err(|e| GitAiError::Generic(format!("Failed to open object database: {}", e)))?;

        // Open ref store
        let ref_store =
            gix_ref::file::Store::at(git_dir.clone(), gix_ref::store::init::Options::default());

        // Try to find refs/notes/ai
        let notes_ref = match ref_store.find_loose("refs/notes/ai") {
            Ok(r) => r,
            _ => return Ok::<_, GitAiError>((git_dir.clone(), Vec::new())),
        };

        // Get the target OID from the reference
        let target_oid = match notes_ref.target {
            gix_ref::Target::Object(oid) => oid,
            _ => return Ok::<_, GitAiError>((git_dir.clone(), Vec::new())),
        };

        // Read the commit object and get its tree
        let mut buffer = Vec::new();
        let commit_data = odb
            .try_find(target_oid.as_ref(), &mut buffer)
            .map_err(|e| GitAiError::Generic(format!("Failed to find notes object: {}", e)))?
            .ok_or_else(|| GitAiError::Generic("Notes commit object not found".to_string()))?;

        let commit = gix_object::CommitRef::from_bytes(&commit_data.data)
            .map_err(|e| GitAiError::Generic(format!("Failed to parse commit: {}", e)))?;

        let tree_oid = commit.tree();

        let mut blob_entries: Vec<(String, gix_hash::ObjectId)> = Vec::new();
        collect_blob_entries(&mut odb, tree_oid, String::new(), &mut blob_entries)?;

        Ok((git_dir, blob_entries))
    })
    .await?;

    // Process blobs in parallel across multiple workers
    let max_concurrent = 64;

    // Split work evenly across workers
    let blobs_per_worker = (blob_entries.len() + max_concurrent - 1) / max_concurrent;
    let worker_chunks: Vec<_> = blob_entries
        .chunks(blobs_per_worker)
        .map(|c| c.to_vec())
        .collect();

    // Spawn workers to process their chunks
    let tasks: Vec<_> = worker_chunks
        .into_iter()
        .map(|chunk| {
            let repo_path = repo_path.clone();
            smol::spawn(async move {
                smol::unblock(move || extract_file_paths_from_batch(repo_path, chunk))
                    .await
                    .unwrap_or_else(|_| HashSet::new())
            })
        })
        .collect();

    // Collect results from all workers into a single HashSet
    let mut all_files = HashSet::new();
    for task in tasks {
        let batch_files = task.await;
        all_files.extend(batch_files);
    }

    Ok(all_files)
}

/// Extract unique file paths from a batch of blobs
fn extract_file_paths_from_batch(
    repo_path: PathBuf,
    blob_entries: Vec<(String, gix_hash::ObjectId)>,
) -> Result<HashSet<String>, GitAiError> {
    use crate::authorship::authorship_log_serialization::AuthorshipLog;

    // Find the .git directory
    let git_dir = if repo_path.join(".git").exists() {
        repo_path.join(".git")
    } else {
        repo_path.clone()
    };

    let odb = gix_odb::at(git_dir.join("objects"))
        .map_err(|e| GitAiError::Generic(format!("Failed to open object database: {}", e)))?;

    let mut files = HashSet::new();
    let mut buffer = Vec::new();

    for (_commit_sha, blob_id) in blob_entries {
        buffer.clear();
        let blob_data = match odb.try_find(blob_id.as_ref(), &mut buffer) {
            Ok(Some(obj)) => obj,
            _ => continue,
        };

        let content = match std::str::from_utf8(&blob_data.data) {
            Ok(s) => s,
            Err(_) => continue,
        };

        // Find the divider and slice before it, then add minimal metadata to make it parseable
        if let Some(divider_pos) = content.find("\n---\n") {
            let attestation_section = &content[..divider_pos];
            // Create a complete parseable format with empty metadata
            let parseable = format!(
                "{}\n---\n{{\"schema_version\":\"authorship/3.0.0\",\"base_commit_sha\":\"\",\"prompts\":{{}}}}",
                attestation_section
            );

            if let Ok(log) = AuthorshipLog::deserialize_from_string(&parseable) {
                for attestation in log.attestations {
                    files.insert(attestation.file_path);
                }
            }
        }
    }

    Ok(files)
}

/// Collect all blob entries from the notes tree (recursive)
fn collect_blob_entries(
    odb: &mut gix_odb::Handle,
    tree_oid: gix_hash::ObjectId,
    prefix: String,
    entries: &mut Vec<(String, gix_hash::ObjectId)>,
) -> Result<(), GitAiError> {
    // Read the tree object
    let mut buffer = Vec::new();
    let tree_data = odb
        .try_find(tree_oid.as_ref(), &mut buffer)
        .map_err(|e| GitAiError::Generic(format!("Failed to find tree: {}", e)))?
        .ok_or_else(|| GitAiError::Generic("Tree object not found".to_string()))?;

    let tree = gix_object::TreeRef::from_bytes(&tree_data.data)
        .map_err(|e| GitAiError::Generic(format!("Failed to parse tree: {}", e)))?;

    for entry in tree.entries {
        let entry_name = std::str::from_utf8(entry.filename)
            .map_err(|e| GitAiError::Generic(format!("Invalid UTF-8 in tree entry: {}", e)))?;
        let full_sha = format!("{}{}", prefix, entry_name);

        match entry.mode.kind() {
            gix_object::tree::EntryKind::Blob => {
                entries.push((full_sha, entry.oid.to_owned()));
            }
            gix_object::tree::EntryKind::Tree => {
                collect_blob_entries(odb, entry.oid.to_owned(), full_sha, entries)?;
            }
            _ => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::find_repository_in_path;
    use std::time::Instant;

    #[test]
    fn test_load_ai_touched_files() {
        smol::block_on(async {
            let repo = find_repository_in_path(".").unwrap();

            let start = Instant::now();
            let files = load_all_ai_touched_files(&repo).await.unwrap();
            let elapsed = start.elapsed();

            println!(
                "Found {} unique AI-touched files in {:?}",
                files.len(),
                elapsed
            );

            // Show first 10 files
            let mut sorted_files: Vec<_> = files.iter().collect();
            sorted_files.sort();
            for file in sorted_files.iter().take(10) {
                println!("  {}", file);
            }
        });
    }
}
