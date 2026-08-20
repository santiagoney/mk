# Mould King 13181 · PWA de control

App local (sin backend) para manejar el plotter MK 13181 (módulo MKH4.0)
desde el celular por Web Bluetooth.

## Estado actual

**Confirmado por la captura HCI real** y ya implementado en `app.js`:

- Service `0000ae3a-…`, característica de escritura `0000ae3b-…`
  (Write Command), notificación `0000ae3c-…`.
- Framing de texto: `T<código>W`. El módulo confirma cada notificación con
  un byte `0x01` crudo — la app lo hace sola.
- Secuencia de arranque real, que se reproduce automáticamente al conectar.
- Frames de movimiento: `T1440` + `AAAA`·0·`BBBB`·0·`CCCC` + `00000W`, tres
  campos hex de 16 bits = tres motores, posición absoluta. Verificado contra
  los 93 frames de la captura (todos encajan). El generador `buildMoveFrame`
  reproduce los frames capturados byte a byte.

**Lo único que falta confirmar sos vos** (no se puede sacar de la captura):
cuál campo A/B/C es X, cuál Y y cuál el lápiz. La captura movió los ejes
pero no dejó anotado cuál era cuál.

## Cómo terminar de activarla (5 minutos, con el plotter delante)

1. Serví la carpeta sobre HTTPS o localhost (Web Bluetooth no anda sobre
   `file://`). Para el celular: subila a GitHub Pages, o servila en la LAN
   y habilitá el origen en `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Abrí la app en Chrome Android, tocá **Conectar** (se reproduce el
   handshake solo).
3. En la consola BLE, apretá **probar campo A**, después **B**, después
   **C**, y anotá qué motor se mueve con cada uno.
4. En `app.js`, ajustá `FIELD_MAP` con lo que observaste (y `invert: true`
   si algún motor va al revés), y poné `FIELD_MAP_CONFIRMED = true`.
5. Listo: el jog, el lápiz y el envío de imagen ya mueven el plotter de
   verdad.

Hasta el paso 4, el jog / lápiz / envío solo escriben en el log — es la red
de seguridad para no mandarle un movimiento al motor equivocado.

## Seguridad

Dejá los topes físicos en los extremos de cada eje hasta que confirmes que
la calibración de límites respeta el recorrido real. `PEN_DOWN_VALUE` en
`app.js` arranca conservador: subilo de a poco hasta que el lápiz apoye sin
forzar.

## Vectorizado

`makeRasterPath` hace un rayado horizontal por umbral (simple pero usable).
Para trazo tipo boceto real, se puede reemplazar por un trazador de
contornos sin tocar el resto.
