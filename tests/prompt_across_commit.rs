#[macro_use]
mod repos;
mod test_utils;

use repos::test_file::ExpectedLineExt;
use repos::test_repo::TestRepo;

#[test]
fn test_change_across_commits() {
    let repo = TestRepo::new();
    let mut file = repo.filename("foo.py");

    file.set_contents(lines![
        "def print_name(name: str) -> None:".ai(),
        "    \"\"\"Print the given name.\"\"\"".ai(),
        "    if name == 'foobar':".ai(),
        "        print('name not allowed!')".ai(),
        "    print(\"Hello World\")".ai(),
        "print_name(\"Michael\")".ai(),
    ]);

    let commit = repo.stage_all_and_commit("Initial all AI").unwrap();
    commit.print_authorship();

    file.replace_at(4, "    name = name.upper()".ai());
    file.insert_at(5, lines!["    print(f\"Hello {name}\")".ai()]);

    let commit = repo.stage_all_and_commit("add more AI").unwrap();
    commit.print_authorship();

    let file_attestation = commit.authorship_log.attestations.first().unwrap();
    // Failing because some of these AI changes are being attributed to the previous AI prompt
    assert_eq!(file_attestation.entries.len(), 1);
}
