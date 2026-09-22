import test from 'node:test';
import assert from 'node:assert/strict';
import { crearJwt, ErrorAutenticacion } from '../src/platform/jwt.js';

const entorno = secreto => ({
  TECNIFIN_JWT_SECRET: secreto,
  TECNIFIN_JWT_ISSUER: 'tecnifin-pruebas',
  TECNIFIN_JWT_AUDIENCE: 'tecnifin-api-pruebas',
});

test('emite y verifica solo HS256 con emisor, audiencia, vigencia y tenant', () => {
  const jwt = crearJwt(entorno('secreto-de-prueba-con-mas-de-32-bytes'), () => 1_000_000);
  const token = jwt.emitir({ usuarioId: '8', cooperativaId: 3, rol: 'ADMIN',
    login: 'admin', vidaSegundos: 60 });
  const claims = jwt.verificar(token);
  assert.equal(claims.sub, '8');
  assert.equal(claims.coop, 3);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(claims.iss, 'tecnifin-pruebas');
});

test('rechaza firma manipulada, otra audiencia y token vencido', () => {
  let ahora = 1_000_000;
  const jwt = crearJwt(entorno('secreto-de-prueba-con-mas-de-32-bytes'), () => ahora);
  const token = jwt.emitir({ usuarioId: '8', cooperativaId: 3, rol: 'ADMIN',
    login: 'admin', vidaSegundos: 1 });
  const partes = token.split('.');
  const cuerpo = JSON.parse(Buffer.from(partes[1], 'base64url'));
  cuerpo.coop = 4;
  partes[1] = Buffer.from(JSON.stringify(cuerpo)).toString('base64url');
  assert.throws(() => jwt.verificar(partes.join('.')), ErrorAutenticacion);
  assert.throws(() => crearJwt(entorno('corta')), /32 bytes/);
  const otraAudiencia = crearJwt({ ...entorno('secreto-de-prueba-con-mas-de-32-bytes'),
    TECNIFIN_JWT_AUDIENCE: 'otra' }, () => ahora);
  assert.throws(() => otraAudiencia.verificar(token), ErrorAutenticacion);
  ahora += 2_000;
  assert.throws(() => jwt.verificar(token), ErrorAutenticacion);
});

