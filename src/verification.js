// Detección de user agents mobile.
// OJO: esto es una barrera DISUASORIA, no infalible — un user agent se puede
// falsificar. El objetivo es que fichar desde el celular no sea trivial.
const MOBILE_PATTERNS = [
  /Android/i, /iPhone/i, /iPad/i, /iPod/i, /webOS/i,
  /BlackBerry/i, /Windows Phone/i, /Opera Mini/i,
  /IEMobile/i, /Mobile Safari/i, /Mobi/i, /Silk/i,
];

const isMobileUA = (ua) => {
  if (!ua) return true; // sin user agent = sospechoso, bloquear
  return MOBILE_PATTERNS.some(p => p.test(ua));
};

module.exports = { isMobileUA };
