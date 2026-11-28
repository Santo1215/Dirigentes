import jwt from 'jsonwebtoken';

export function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const partes = header.split(' ');
  const token = partes.length === 2 ? partes[1] : partes[0];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

export function requerirRol(...rolesPermitidos) {
  const normalizar = (txt) =>
    (txt || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  const rolesNormalizados = rolesPermitidos.map(normalizar);

  return (req, res, next) => {
    if (!req.user || !req.user.rol) {
      return res.status(403).json({ error: 'Acceso denegado: rol no especificado' });
    }

    const rolUsuario = normalizar(req.user.rol);
    if (!rolesNormalizados.includes(rolUsuario)) {
      return res.status(403).json({ error: 'Acceso denegado: permisos insuficientes' });
    }

    next();
  };
}

export default auth;
