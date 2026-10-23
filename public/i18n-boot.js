/**
 * Arranca las traducciones antes de que app.js pinte nada.
 * El idioma se guarda en localStorage y se detecta del navegador la primera vez.
 */
import { aplicar, vigilar } from "/i18n.js?v=2";

aplicar();
vigilar();
