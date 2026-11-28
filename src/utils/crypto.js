import crypto from 'crypto';

export function generarContrasena(longitud = 9) {
  const mayus = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const minus = 'abcdefghijklmnopqrstuvwxyz';
  const numeros = '0123456789';
  const todos = mayus + minus + numeros;

  const chars = [
    mayus[crypto.randomInt(0, mayus.length)],
    minus[crypto.randomInt(0, minus.length)],
    numeros[crypto.randomInt(0, numeros.length)],
  ];

  for (let i = chars.length; i < longitud; i++) {
    chars.push(todos[crypto.randomInt(0, todos.length)]);
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

export async function generarCodigoUnico(client) {
  let codigo;
  let existe = true;

  while (existe) {
    codigo = generarCodigo();
    const check = await client.query(
      'SELECT 1 FROM dirigente WHERE codigo = $1',
      [codigo]
    );
    existe = check.rowCount > 0;
  }

  return codigo;
}

export function generarCodigo(min = 2000000, max = 29999999) {
  return crypto.randomInt(min, max + 1).toString();
}
