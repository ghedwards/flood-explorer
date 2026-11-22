//! A Node addon exposing `run(op, bag) -> Buffer`, the same entry point the
//! WebAssembly module gives the browser, so the JavaScript bridge and its
//! tests run against the Rust model on machines without the wasm32 target.
//! Node-API's C functions are declared here (its ABI is stable), so no
//! headers or outside crates are needed. Build, then copy
//! target/release/libflood_node.so to flood-node.node.

use std::ffi::c_void;
use std::os::raw::c_char;

type Env = *mut c_void;
type Value = *mut c_void;
type Info = *mut c_void;
type Callback = unsafe extern "C" fn(Env, Info) -> Value;

extern "C" {
    fn napi_create_function(env: Env, name: *const c_char, len: usize, cb: Callback, data: *mut c_void, result: *mut Value) -> i32;
    fn napi_set_named_property(env: Env, obj: Value, name: *const c_char, value: Value) -> i32;
    fn napi_get_cb_info(env: Env, info: Info, argc: *mut usize, argv: *mut Value, this: *mut Value, data: *mut *mut c_void) -> i32;
    fn napi_get_value_string_utf8(env: Env, v: Value, buf: *mut c_char, size: usize, result: *mut usize) -> i32;
    fn napi_get_typedarray_info(env: Env, v: Value, ty: *mut i32, len: *mut usize, data: *mut *mut c_void, ab: *mut Value, off: *mut usize) -> i32;
    fn napi_create_buffer_copy(env: Env, len: usize, data: *const c_void, result_data: *mut *mut c_void, result: *mut Value) -> i32;
    fn napi_throw_error(env: Env, code: *const c_char, msg: *const c_char) -> i32;
}

unsafe extern "C" fn run(env: Env, info: Info) -> Value {
    let mut argc = 2usize;
    let mut argv = [std::ptr::null_mut(); 2];
    if napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut()) != 0 || argc < 2 {
        napi_throw_error(env, std::ptr::null(), c"run(op, bytes)".as_ptr());
        return std::ptr::null_mut();
    }
    let mut len = 0usize;
    if napi_get_value_string_utf8(env, argv[0], std::ptr::null_mut(), 0, &mut len) != 0 {
        napi_throw_error(env, std::ptr::null(), c"op must be a string".as_ptr());
        return std::ptr::null_mut();
    }
    let mut op = vec![0u8; len + 1];
    if napi_get_value_string_utf8(env, argv[0], op.as_mut_ptr() as *mut c_char, len + 1, &mut len) != 0 {
        napi_throw_error(env, std::ptr::null(), c"op must be a string".as_ptr());
        return std::ptr::null_mut();
    }
    let (mut ty, mut n, mut data, mut off) = (0i32, 0usize, std::ptr::null_mut(), 0usize);
    let mut ab = std::ptr::null_mut();
    if napi_get_typedarray_info(env, argv[1], &mut ty, &mut n, &mut data, &mut ab, &mut off) != 0 || ty != 1 {
        napi_throw_error(env, std::ptr::null(), c"bytes must be a Uint8Array".as_ptr());
        return std::ptr::null_mut();
    }
    let p = flood_wasm::flood_run(op.as_ptr(), len, data as *const u8, n);
    let out_n = flood_wasm::flood_out_len();
    let mut res = std::ptr::null_mut();
    if napi_create_buffer_copy(env, out_n, p as *const c_void, std::ptr::null_mut(), &mut res) != 0 {
        napi_throw_error(env, std::ptr::null(), c"failed to allocate output buffer".as_ptr());
        return std::ptr::null_mut();
    }
    res
}

/// Register the native module with Node.js.
///
/// # Safety
/// Node.js must supply a live N-API environment and an exports object belonging
/// to that environment, on its JavaScript thread.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Value) -> Value {
    let mut f = std::ptr::null_mut();
    if napi_create_function(env, c"run".as_ptr(), 3, run, std::ptr::null_mut(), &mut f) != 0 {
        return std::ptr::null_mut();
    }
    if napi_set_named_property(env, exports, c"run".as_ptr(), f) != 0 {
        return std::ptr::null_mut();
    }
    exports
}
