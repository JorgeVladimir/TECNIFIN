// Pool de mentira para probar la capa de acceso sin base de datos: registra el texto y
// los valores de cada consulta y puede fallar en la que se le pida.
export function poolFalso(fallaEn = []) {
  const llamadas = [], liberaciones = [];
  let tenantActual = null;
  const cliente = {
    async query(consulta) {
      const { text, values = [] } = typeof consulta === 'string' ? { text: consulta } : consulta;
      llamadas.push({ texto: text, valores: values });
      if (fallaEn.includes(text)) throw new Error(text);
      if (text === 'SELECT set_config($1, $2, true)' && values[0] === 'app.cooperativa_id') {
        tenantActual = values[1];
      }
      if (text.includes('current_setting($1, true) AS cooperativa_id')) {
        return { rows: [{ cooperativa_id: tenantActual, conexion_id: '99', transaccion_id: '7' }] };
      }
      return { rows: [{ ok: true }] };
    },
    release(error) { liberaciones.push(error); },
  };
  return {
    pool: { async connect() { return cliente; } },
    llamadas, liberaciones,
    textos: () => llamadas.map(l => l.texto),
    cambiarTenant: valor => { tenantActual = String(valor); },
  };
}
