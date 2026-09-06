mod cli;
mod launcher;

fn main() {
    // A read of a partial clone must report a missing object, not fetch it as
    // an implicit side effect. This process has not started any threads yet.
    std::env::set_var("GIT_NO_LAZY_FETCH", "1");
    strand_core::init();
    let args: Vec<_> = std::env::args().collect();
    let json = args.iter().any(|arg| arg == "--json");
    if let Err(error) = cli::run(args) {
        if json {
            eprintln!("{}", serde_json::to_string(&error).unwrap());
        } else {
            eprintln!("{}: {}", error.code, error.message);
        }
        std::process::exit(match error.code.as_str() {
            "invalid_request" => 2,
            "repository" => 3,
            "output_limit" => 4,
            _ => 5,
        });
    }
}
