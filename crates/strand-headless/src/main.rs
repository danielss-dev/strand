mod launcher;

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] || args == ["-h"] {
        println!("strand PATH\n\nOpen a repository in the Strand desktop app.\nSet STRAND_DESKTOP to an absolute desktop executable path for a standalone install.");
        return;
    }
    if args == ["--version"] {
        println!("strand {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if let Err(message) = launcher::launch(&args) {
        eprintln!("{message}");
        std::process::exit(2);
    }
}
