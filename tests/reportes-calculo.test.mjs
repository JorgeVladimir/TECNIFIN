// Aritmetica de los reportes sin coma flotante: porcentaje con 2 decimales y producto por
// una fraccion (ponderaciones, factores) redondeados a la mitad, tambien con negativos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { porcentaje, porFraccion } from '../src/modules/reportes/servicio.js';

test('porcentaje: dos decimales, redondeo a la mitad y signo correcto', () => {
  assert.equal(porcentaje(602500, 1200000), '50.21');
  assert.equal(porcentaje(600000, 1202500), '49.90');
  assert.equal(porcentaje(1, 3), '33.33');
  assert.equal(porcentaje(2, 3), '66.67');
  assert.equal(porcentaje(-1500, 100000), '-1.50', 'una perdida da ROA negativo');
  assert.equal(porcentaje(-1, 3), '-33.33');
  assert.equal(porcentaje(0, 5), '0.00');
  assert.equal(porcentaje(5, 0), null, 'sin denominador no hay indicador');
  assert.equal(porcentaje(1e13, 1e13), '100.00', 'montos grandes sin perder precision');
});

test('porFraccion: centavos por ponderacion redondeados al centavo', () => {
  assert.equal(porFraccion(1000, '0.2'), 200);
  assert.equal(porFraccion(12345, '0.0125'), 154, '154.3125 -> 154');
  assert.equal(porFraccion(12360, '0.0125'), 155, '154.5 -> 155');
  assert.equal(porFraccion(-12360, '0.0125'), -155);
  assert.equal(porFraccion(100, '1'), 100);
  assert.equal(porFraccion(10000, '0.09'), 900);
});
