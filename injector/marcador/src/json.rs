//! JSON mínimo: objeto plano com valores string/número/bool/null (o suficiente para o protocolo do pipe).
use std::collections::HashMap;

#[allow(dead_code)]
pub enum V { S(String), N(f64), B(bool), Null }
impl V {
    pub fn as_str(&self) -> Option<&str> { if let V::S(s) = self { Some(s) } else { None } }
    pub fn as_f64(&self) -> Option<f64> { match self { V::N(n) => Some(*n), V::S(s) => s.parse().ok(), _ => None } }
}

pub fn esc(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

pub fn parse_obj(s: &str) -> Result<HashMap<String, V>, String> {
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    let ws = |i: &mut usize| while *i < c.len() && c[*i].is_whitespace() { *i += 1 };
    let mut out = HashMap::new();
    ws(&mut i);
    if c.get(i) != Some(&'{') { return Err("esperado '{'".into()); }
    i += 1;
    loop {
        ws(&mut i);
        if c.get(i) == Some(&'}') { break; }
        let k = string(&c, &mut i)?;
        ws(&mut i);
        if c.get(i) != Some(&':') { return Err("esperado ':'".into()); }
        i += 1;
        ws(&mut i);
        let v = match c.get(i) {
            Some('"') => V::S(string(&c, &mut i)?),
            Some('t') if c[i..].starts_with(&['t', 'r', 'u', 'e']) => { i += 4; V::B(true) }
            Some('f') if c[i..].starts_with(&['f', 'a', 'l', 's', 'e']) => { i += 5; V::B(false) }
            Some('n') if c[i..].starts_with(&['n', 'u', 'l', 'l']) => { i += 4; V::Null }
            Some(_) => {
                let st = i;
                while i < c.len() && (c[i].is_ascii_digit() || "+-.eE".contains(c[i])) { i += 1; }
                let t: String = c[st..i].iter().collect();
                V::N(t.parse().map_err(|_| format!("numero invalido '{t}'"))?)
            }
            None => return Err("fim inesperado".into()),
        };
        out.insert(k, v);
        ws(&mut i);
        match c.get(i) {
            Some(',') => i += 1,
            Some('}') => break,
            _ => return Err("esperado ',' ou '}'".into()),
        }
    }
    Ok(out)
}

fn string(c: &[char], i: &mut usize) -> Result<String, String> {
    if c.get(*i) != Some(&'"') { return Err("esperado string".into()); }
    *i += 1;
    let mut o = String::new();
    while *i < c.len() {
        match c[*i] {
            '"' => { *i += 1; return Ok(o); }
            '\\' => {
                *i += 1;
                match c.get(*i) {
                    Some('n') => o.push('\n'),
                    Some('t') => o.push('\t'),
                    Some('u') => {
                        let h: String = c.get(*i + 1..*i + 5).ok_or("\\u curto")?.iter().collect();
                        o.push(char::from_u32(u32::from_str_radix(&h, 16).map_err(|_| "\\u invalido")?).unwrap_or('?'));
                        *i += 4;
                    }
                    Some(&x) => o.push(x),
                    None => return Err("escape no fim".into()),
                }
            }
            x => o.push(x),
        }
        *i += 1;
    }
    Err("string sem fim".into())
}
