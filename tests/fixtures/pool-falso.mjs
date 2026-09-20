// Pool de mentira para probar la capa de acceso sin base de datos: registra el texto y
// los valores de cada consulta y puede fallar en la que se le pida.
export function poolFalso(fallaEn = []) {
  const llamadas = [], liberaciones = [];
  const cliente = {
    async query(consulta) {
      const { text, values = [] } = typeof consulta === 'string' ? { text: consulta } : consulta;
      llamadas.push({ texto: text, valores: values });
      if (fallaEn.includes(text)) throw new Error(text);
      return { rows: [{ ok: true }] };
    },
    release(error) { liberaciones.push(error); },
  };
  return {
    pool: { async connect() { return cliente; } },
    llamadas, liberaciones,
    textos: () => llamadas.map(l => l.texto),
  };
}
