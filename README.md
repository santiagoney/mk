# Mould King 13181 · PWA de control

Control del plotter MK 13181 (módulo YX-013CX1 / MKH4.0) por Web Bluetooth
desde Android. Flujo: Conectar → Calibrar → Figura → Enviar.

## Protocolo (confirmado por captura HCI + pruebas)
- Service ae3a / write ae3b / notify ae3c. Frames de texto "T...W".
- Movimiento: T1440 + A(4hex) 0 B(4hex) 0 C(4hex) + 00000 W.
- Cada campo es VELOCIDAD con reposo en 0x0000. Sentido partido en 0x8000:
  0x0001–0x7FFF un sentido, 0x8000–0xFFFF el otro. Frenar = 0.
- Mapeo: X=campo B (invertido), Y=campo A, lápiz=campo C.

## Uso
1. Conectar (hace el handshake solo).
2. Calibrar: jog de cada eje (pulsos que frenan solos), fijar límites,
   ajustar lápiz, y medir la PROPORCIÓN de ejes (los ejes avanzan distinto
   por pulso; medí pulsos por tramo en X y en Y y guardá).
3. Figura: elegí cuadrado/línea/ele, tamaño en pulsos, simulá.
4. Enviar al plotter. Botón FRENAR TODO corta al instante.

## Notas
- Control a lazo abierto (sin sensor de posición): el dibujo es aproximado.
- La proporción de ejes compensa que Y avanza mucho menos por pulso que X.
