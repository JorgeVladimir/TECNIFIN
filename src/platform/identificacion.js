// Cedula ecuatoriana: digito verificador por modulo 10.
//
// Se usa para validar lo que entra por pantalla y para GENERAR las cedulas sinteticas de
// la base de demostracion: una cedula de demo tiene que pasar la misma validacion que
// una real, o la demo no demuestra nada (y peor: esconde el bug de la validacion).
//
// Regla: coeficientes 2,1,2,1,2,1,2,1,2 sobre los nueve primeros digitos; si el producto
// pasa de 9 se le resta 9; el verificador es el complemento a la decena de la suma.
const COEFICIENTES = [2, 1, 2, 1, 2, 1, 2, 1, 2];

export function digitoVerificadorCedula(nueveDigitos) {
  if (!/^[0-9]{9}$/.test(nueveDigitos)) throw new TypeError('Se esperan exactamente 9 digitos');
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    const producto = Number(nueveDigitos[i]) * COEFICIENTES[i];
    suma += producto > 9 ? producto - 9 : producto;
  }
  return (10 - (suma % 10)) % 10;
}

export function esCedulaValida(cedula) {
  if (!/^[0-9]{10}$/.test(cedula || '')) return false;
  const provincia = Number(cedula.slice(0, 2));
  // Provincias 1..24, mas 30 para los nacidos en el exterior.
  if (!((provincia >= 1 && provincia <= 24) || provincia === 30)) return false;
  // El tercer digito distingue a la persona natural (0-5) de otros tipos de registro.
  if (Number(cedula[2]) > 5) return false;
  return digitoVerificadorCedula(cedula.slice(0, 9)) === Number(cedula[9]);
}

// Completa una base de 9 digitos con su verificador. Para la demo: la base la fija el
// generador y el decimo digito lo pone el algoritmo, no una constante escrita a mano.
export function cedulaDesdeBase(nueveDigitos) {
  return nueveDigitos + String(digitoVerificadorCedula(nueveDigitos));
}
