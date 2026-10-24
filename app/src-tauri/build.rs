fn main() {
    // a DLL dos pins (injector/marcador) vai embutida no exe (src/injetor.rs): compila ela antes, sempre a partir
    // do código atual, para o exe nunca levar uma DLL velha
    let raiz = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../injector");
    println!("cargo:rerun-if-changed={}", raiz.join("marcador/src").display());
    println!("cargo:rerun-if-changed={}", raiz.join("marcador/Cargo.toml").display());
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let st = std::process::Command::new(cargo)
        .args(["build", "--release", "-p", "marcador"])
        .current_dir(&raiz)
        .env_remove("CARGO_TARGET_DIR")
        .status()
        .expect("não deu para rodar o cargo para compilar a DLL dos pins (injector/marcador)");
    assert!(st.success(), "a DLL dos pins (injector/marcador) não compilou");
    tauri_build::build()
}
