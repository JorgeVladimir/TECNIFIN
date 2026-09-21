// Cedula ecuatoriana y tabla de amortizacion: las dos reglas de calculo que la base de
// demostracion usa. Si fueran mentira, la demo mostraria datos que el sistema rechazaria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitoVerificadorCedula, esCedulaValida, cedulaDesdeBase } from '../src/platform/identificacion.js';
import { amortizacionFrancesa } from '../tools/demo-datos.mjs';

test('el digito verificador sale del modulo 10 con los coeficientes 2,1,2,1,2,1,2,1,2', () => {
  // Calculo a mano de '170000001': 1*2=2, 7*1=7, 0, 0, 0, 0, 0, 0, 1*2=2 -> suma 11
  // -> verificador (10 - 11 % 10) % 10 = 9.
  assert.equal(digitoVerificadorCedula('170000001'), 9);
  // Un producto mayor que 9 se reduce restando 9: 9*2 = 18 -> 9. Sin esa reduccion la
  // suma de '179999999' daria 126 y el verificador 4 en vez de 8.
  assert.equal(digitoVerificadorCedula('179999999'), 8);
  assert.throws(() => digitoVerificadorCedula('12345'), TypeError);
});

test('las cedulas sinteticas de la demo pasan la validacion completa', () => {
  for (let n = 1; n <= 6; n++) {
    const cedula = cedulaDesdeBase(`17000000${n}`);
    assert.ok(esCedulaValida(cedula), `cedula invalida: ${cedula}`);
  }
});

test('la validacion rechaza provincia, tipo de persona y verificador imposibles', () => {
  assert.equal(esCedulaValida('9900000019'), false, 'provincia 99 no existe');
  assert.equal(esCedulaValida('1790000015'), false, 'tercer digito 9 no es persona natural');
  assert.equal(esCedulaValida('1700000010'), false, 'verificador equivocado');
  assert.equal(esCedulaValida('170000001'), false, 'nueve digitos no son una cedula');
  assert.equal(esCedulaValida(null), false);
});

test('la amortizacion francesa cierra exactamente contra el monto', () => {
  for (const [monto, tasa, cuotas] of [[6000, 15, 12], [3000, 22, 24], [120000, 10, 180]]) {
    const filas = amortizacionFrancesa(monto, tasa, cuotas);
    assert.equal(filas.length, cuotas);
    const capital = filas.reduce((s, f) => s + f.capital, 0);
    // Sin el ajuste de la ultima cuota, el redondeo por cuota deja centavos sueltos y la
    // suma del capital no es el monto prestado.
    assert.equal(Math.round(capital * 100) / 100, monto);
    assert.ok(filas.every(f => f.capital > 0 && f.interes >= 0));
    assert.ok(filas[0].interes > filas[cuotas - 1].interes, 'el interes decrece');
  }
});
