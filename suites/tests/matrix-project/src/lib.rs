#[test]
fn selected_features_compile() {
    let selected = [cfg!(feature = "baseline"), cfg!(feature = "changed")];
    assert!(selected.into_iter().any(|enabled| enabled));
}

#[cfg(windows)]
#[test]
fn native_windows_strings() {
    use std::os::windows::ffi::OsStrExt;
    assert_eq!(std::ffi::OsStr::new("matrix").encode_wide().count(), 6);
}
