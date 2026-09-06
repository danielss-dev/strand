// Dependency-free peer compiled by the transport tests. Never used by the app.
use std::io::{self, BufRead, Write};
fn main() {
    let mode = std::env::args().nth(1).unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let id = line
            .split("\"id\":")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        match mode.as_str() {
            "null" => println!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":null}}"),
            "malformed" => println!("invalid JSON"),
            "unknown" => println!("{{\"jsonrpc\":\"2.0\",\"id\":9999,\"result\":null}}"),
            "truncated" => {
                print!("{{");
                return;
            }
            "eof" => return,
            "oversized" => {
                io::stdout()
                    .write_all(&vec![b'x'; 8 * 1024 * 1024 + 1])
                    .unwrap();
            }
            "stderr" => {
                io::stderr().write_all(&vec![b'x'; 70_000]).unwrap();
            }
            "hang" => std::thread::sleep(std::time::Duration::from_secs(600)),
            _ => panic!("unknown fixture mode"),
        }
        io::stdout().flush().unwrap();
    }
}
