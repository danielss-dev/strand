use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("repository not found at {0}")]
    NotARepo(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("gix open error: {0}")]
    GixOpen(#[from] gix::open::Error),

    #[error("gix discover error: {0}")]
    GixDiscover(#[from] gix::discover::Error),

    #[error("git2 error: {0}")]
    Git2(#[from] git2::Error),

    /// The user cancelled a long-running op (clone/fetch/pull/push). Not a
    /// failure — the UI shows it quietly instead of as an error toast.
    #[error("cancelled")]
    Cancelled,

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
