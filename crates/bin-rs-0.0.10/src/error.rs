use std::error::Error;
use std::fmt;
/// 0.0.9


#[derive(Debug)]
pub struct BinError {
    pub(crate) side: &'static &'static str,
    pub(crate) message: Box<String>,
}

impl fmt::Display for BinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.side,self.message)
    }
}

impl Error for BinError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self)
    }
}