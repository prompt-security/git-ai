use indicatif::{ProgressBar, ProgressStyle};

/// Spinner UI component for showing progress
pub struct Spinner {
    pb: ProgressBar,
}

impl Spinner {
    pub fn new(message: &str) -> Self {
        let pb = ProgressBar::new_spinner();
        pb.set_style(
            ProgressStyle::default_spinner()
                .template("{spinner:.green} {msg}")
                .unwrap()
                .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
        );
        pb.set_message(message.to_string());
        pb.enable_steady_tick(std::time::Duration::from_millis(100));

        Self { pb }
    }

    pub fn start(&self) {
        // Spinner starts automatically when created
    }

    #[allow(dead_code)]
    pub fn update_message(&self, message: &str) {
        self.pb.set_message(message.to_string());
    }

    #[allow(dead_code)]
    pub async fn wait_for(&self, duration_ms: u64) {
        smol::Timer::after(std::time::Duration::from_millis(duration_ms)).await;
    }

    pub fn success(&self, message: &str) {
        // Clear spinner and show success with green checkmark and bold green text
        self.pb.finish_and_clear();
        println!("\x1b[1;32m✓ {}\x1b[0m", message);
    }

    pub fn pending(&self, message: &str) {
        // Clear spinner and show pending with yellow warning triangle and bold yellow text
        self.pb.finish_and_clear();
        println!("\x1b[1;33m⚠ {}\x1b[0m", message);
    }

    pub fn error(&self, message: &str) {
        // Clear spinner and show error with red X and bold red text
        self.pb.finish_and_clear();
        println!("\x1b[1;31m✗ {}\x1b[0m", message);
    }

    #[allow(dead_code)]
    pub fn skipped(&self, message: &str) {
        // Clear spinner and show skipped with gray circle and gray text
        self.pb.finish_and_clear();
        println!("\x1b[90m○ {}\x1b[0m", message);
    }
}

/// Print a formatted diff using colors
pub fn print_diff(diff_text: &str) {
    // Print a formatted diff using colors
    for line in diff_text.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            // File headers in bold
            println!("\x1b[1m{}\x1b[0m", line);
        } else if line.starts_with('+') {
            // Additions in green
            println!("\x1b[32m{}\x1b[0m", line);
        } else if line.starts_with('-') {
            // Deletions in red
            println!("\x1b[31m{}\x1b[0m", line);
        } else if line.starts_with("@@") {
            // Hunk headers in cyan
            println!("\x1b[36m{}\x1b[0m", line);
        } else {
            // Context lines normal
            println!("{}", line);
        }
    }
    println!(); // Blank line after diff
}
