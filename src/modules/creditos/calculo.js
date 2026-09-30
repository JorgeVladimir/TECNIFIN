// Calculos de credito sin base de datos: tabla de amortizacion y bandas de cartera.
//
// Dinero en CENTAVOS ENTEROS. La unica operacion en coma flotante es la formula de la
// cuota (necesita una potencia); su resultado se redondea a centavos una vez y desde ahi
// todo es aritmetica entera: el capital de las cuotas suma EXACTAMENTE el monto porque la
// ultima cuota absorbe el residuo del redondeo.

const aCentavos = (texto) => {
  const [enteros, dec = ''] = String(texto).split('.');
  return Number(enteros) * 100 + Number((dec + '00').slice(0, 2));
};
export const aTexto = (centavos) => {
  const signo = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  return `${signo}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

// Sistema frances (cuota fija). tasaAnual en % nominal anual, periodos mensuales.
export function amortizacionFrancesa(monto, tasaAnual, plazo) {
  const m = aCentavos(monto);
  if (!Number.isSafeInteger(m) || m <= 0 || m > 1e13) throw new RangeError('Monto fuera de rango');
  if (!Number.isInteger(plazo) || plazo < 1 || plazo > 600) throw new RangeError('Plazo fuera de rango');
  const i = Number(tasaAnual) / 1200;
  if (!Number.isFinite(i) || i < 0) throw new RangeError('Tasa invalida');
  const cuota = i === 0 ? Math.ceil(m / plazo) : Math.round((m * i) / (1 - Math.pow(1 + i, -plazo)));
  const filas = [];
  let saldo = m;
  for (let n = 1; n <= plazo; n++) {
    const interes = Math.round(saldo * i);
    const capital = n === plazo ? saldo : Math.min(saldo, cuota - interes);
    saldo -= capital;
    filas.push({ numero: n, capital, interes, total: capital + interes, saldo });
  }
  return { cuota, filas };
}

export function tablaEnTexto({ cuota, filas }) {
  return {
    cuota: aTexto(cuota),
    totalInteres: aTexto(filas.reduce((s, f) => s + f.interes, 0)),
    totalPagar: aTexto(filas.reduce((s, f) => s + f.total, 0)),
    cuotas: filas.map(f => ({ numero: f.numero, capital: aTexto(f.capital), interes: aTexto(f.interes),
      total: aTexto(f.total), saldo: aTexto(f.saldo) })),
  };
}

// Familias del Catalogo Unico por segmento y estado (mismo mapa que el motor anterior).
export const FAMILIA_CARTERA = {
  COMERCIAL: { POR_VENCER: '1401', NO_DEVENGA: '1411', VENCIDA: '1421' },
  CONSUMO: { POR_VENCER: '1402', NO_DEVENGA: '1412', VENCIDA: '1422' },
  VIVIENDA: { POR_VENCER: '1403', NO_DEVENGA: '1413', VENCIDA: '1423' },
  MICROEMPRESA: { POR_VENCER: '1404', NO_DEVENGA: '1414', VENCIDA: '1424' },
};
// Ingreso por intereses de cartera por segmento (familia 5104).
export const CUENTA_INTERES = { COMERCIAL: '510405', CONSUMO: '510410', VIVIENDA: '510415', MICROEMPRESA: '510420' };

// Bandas de antiguedad desde el plan de cuentas: NUNCA una tabla en el codigo, porque no
// son simetricas entre familias (1402 corta en 360, 1422 en 270, 1423 tiene seis bandas).
export function bandasDesdePlan(filas) {
  const RANGO = /De\s+(\d+)\s+a\s+(\d+)/i;
  const ABIERTO = /De\s+m[aá]s\s+de\s+(\d+)/i;
  const bandas = {};
  for (const { codigo, nombre } of filas) {
    const rango = String(nombre).match(RANGO);
    const abierto = String(nombre).match(ABIERTO);
    if (!rango && !abierto) continue;
    (bandas[codigo.slice(0, 4)] ??= []).push(rango
      ? { codigo, desde: Number(rango[1]), hasta: Number(rango[2]) }
      : { codigo, desde: Number(abierto[1]) + 1, hasta: null });
  }
  for (const lista of Object.values(bandas)) lista.sort((a, b) => a.desde - b.desde);
  return bandas;
}

// Subcuenta de una familia para una antiguedad en dias (plazo remanente o dias de mora).
// null si la familia no tiene bandas: no se inventa una cuenta.
export function cuentaPorBanda(bandas, familia, dias) {
  const lista = bandas[familia];
  if (!lista?.length) return null;
  const d = Math.max(1, Math.ceil(dias));
  return (lista.find(b => d >= b.desde && (b.hasta === null || d <= b.hasta)) || lista.at(-1)).codigo;
}
