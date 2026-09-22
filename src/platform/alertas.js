// Destino operacional fuera de la transaccion de negocio. Solo acepta campos de
// correlacion enumerados: nunca serializa peticiones, tokens, claves ni texto SQL.
const CAMPOS = [
  'tipo', 'fase', 'solicitudId', 'usuarioLogin', 'cooperativaEsperada',
  'cooperativaObservada', 'conexionId', 'transaccionId', 'motivo',
];

export function crearAlertador(escribir = linea => console.error(linea), reloj = () => new Date()) {
  if (typeof escribir !== 'function') throw new TypeError('escribir debe ser una funcion');
  return async function alertar(evento) {
    const limpio = { nivel: 'ALTO', fecha: reloj().toISOString() };
    for (const campo of CAMPOS) {
      if (evento?.[campo] !== undefined && evento[campo] !== null) limpio[campo] = evento[campo];
    }
    escribir(JSON.stringify(limpio));
  };
}

