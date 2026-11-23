// Décodeur du format compact renvoyé par le serveur OP.GG :
//   class Runes: id,primary_page_id,…      ← en-têtes (noms des champs, dans l'ordre)
//   LolGetChampionAnalysis(Data(Summary(234,false,…),"AD",[…],…))   ← valeurs positionnelles
// On reconstruit des objets JS avec les vrais noms de champs.
export function parseOpgg(text) {
  if (typeof text !== 'string') return text;
  const classes = {};
  const lines = text.split('\n');
  let start = 0;
  for (; start < lines.length; start++) {
    const m = lines[start].match(/^class (\w+): (.*)$/);
    if (!m) break;
    classes[m[1]] = m[2].split(',').map((s) => s.trim());
  }
  const src = lines.slice(start).join('\n').trim();
  let i = 0;

  const ws = () => { while (/\s/.test(src[i])) i++; };
  function value() {
    ws();
    const c = src[i];
    if (c === '"') {
      let out = '';
      i++;
      while (src[i] !== '"') {
        if (src[i] === '\\') { i++; out += src[i] === 'n' ? '\n' : src[i]; } else out += src[i];
        i++;
        if (i > src.length) throw new Error('Chaîne non terminée');
      }
      i++;
      return out;
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (src[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value()); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        throw new Error(`« ] » attendu en ${i}`);
      }
    }
    const word = src.slice(i).match(/^[-+]?[\w.]+/)?.[0];
    if (!word) throw new Error(`Valeur inattendue en ${i}`);
    i += word.length;
    if (src[i] === '(') { // Constructeur : Nom(arg1, arg2, …)
      i++;
      const args = [];
      ws();
      if (src[i] !== ')') {
        for (;;) {
          args.push(value()); ws();
          if (src[i] === ',') { i++; continue; }
          if (src[i] === ')') break;
          throw new Error(`« ) » attendu en ${i}`);
        }
      }
      i++;
      const fields = classes[word];
      if (!fields) return args;
      return Object.fromEntries(fields.map((f, k) => [f, args[k] ?? null]));
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null' || word === 'None') return null;
    const n = Number(word);
    return Number.isNaN(n) ? word : n;
  }

  return value();
}
