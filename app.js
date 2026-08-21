// Mould King 13181 plotter PWA
// BLE protocol is intentionally isolated in MKBleAdapter.
// Once the real UUIDs/commands are captured, only that class needs changing.

const state = {
  pos: { x: 0, y: 0 },
  // Límites en UNIDADES DE MÁQUINA (campos 0..65535). El default es el rango
  // observado en la captura; recalibralo con el jog para tu unidad real.
  limits: { x: [0, 61000], y: [0, 61000] },
  pen: false,
  image: null,
  path: []
};

const $ = id => document.getElementById(id);
const log = msg => {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $("log").textContent += line + "\n";
  $("log").scrollTop = $("log").scrollHeight;
};

/**
 * Protocolo MK 13181 (módulo MKH4.0) — extraído de una captura HCI real
 * (nRF/Android → Wireshark, filtro btatt) el 20 ago 2026.
 *
 * CONFIRMADO por la captura:
 *   - Service:            0000ae3a-0000-1000-8000-00805f9b34fb
 *   - Característica TX:  0000ae3b-0000-1000-8000-00805f9b34fb  (Write Command,
 *     osea writeValueWithoutResponse — la app oficial nunca espera respuesta GATT)
 *   - Característica RX:  0000ae3c-0000-1000-8000-00805f9b34fb  (Notify)
 *   - Framing: texto ASCII plano, "T" + código/payload + "W". Nada de binario
 *     empaquetado — se puede armar y leer a mano.
 *   - Después de CADA notificación recibida, la app oficial responde con un
 *     byte crudo 0x01 (NO envuelto en T...W) antes de mandar el próximo
 *     comando. Sin ese ACK el módulo puede dejar de notificar.
 *   - Secuencia de arranque real (se manda una sola vez, apenas conecta):
 *       TX  T041AABBW
 *       RX  T01711W          -> TX 0x01
 *       TX  T00CW
 *       RX  T027C08W         -> TX 0x01
 *       TX  T006W
 *       RX  T23760101+0064B540-017D7840+0007A12006A8W   (reporte de posición)
 *                            -> TX 0x01
 *       TX  T01F1W
 *       RX  T017F1W          -> TX 0x01
 *
 * MOVIMIENTO — estructura CONFIRMADA por la captura (93/93 frames encajan):
 *   "T1440" + AAAA + "0" + BBBB + "0" + CCCC + "00000" + "W"
 *   -> tres campos hex de 16 bits (0..65535). En la captura cada tanda movió
 *      UN solo campo a la vez, con rampa monótona que sube y vuelve a 0 =>
 *      son POSICIONES ABSOLUTAS por motor, no velocidades. El módulo MKH4.0
 *      tiene 3 motores, así que A/B/C = los 3 ejes (X, Y, lápiz).
 *
 * LO QUE LA CAPTURA NO DICE (y por eso NO lo adivinamos):
 *   - Cuál de A/B/C es X, cuál Y, cuál lápiz. -> FIELD_MAP abajo es una
 *     conjetura que VOS confirmás empíricamente con los botones "probar
 *     campo A/B/C" de la consola: mandá un movimiento chico y mirá qué motor
 *     se mueve, después ajustás FIELD_MAP. Hasta confirmarlo, moveAxis avisa.
 *   - El máximo físico real (en la captura el campo llegó a ~61600, pero no
 *     sabemos si es el tope o solo hasta donde se movió). Por eso el jog
 *     manda pasos RELATIVOS chicos y vos definís los límites calibrando.
 *   - Qué son T041AABBW / T00CW / T006W / T01F1W (handshake — se reproducen
 *     tal cual, no hace falta entenderlos para que funcionen).
 */
const MK_CONFIG = {
  serviceUUID: "0000ae3a-0000-1000-8000-00805f9b34fb",
  writeCharUUID: "0000ae3b-0000-1000-8000-00805f9b34fb",
  notifyCharUUID: "0000ae3c-0000-1000-8000-00805f9b34fb",
};

// Secuencia de arranque capturada, tal cual — ver comentario de arriba.
const MK_HANDSHAKE = ["T041AABBW", "T00CW", "T006W", "T01F1W"];

// Conjetura de mapeo campo->eje. VERIFICAR con los botones de la consola y
// corregir acá. field: "A" | "B" | "C". invert: si el motor va al revés.
const FIELD_MAP = {
  x: { field: "B", invert: false },
  y: { field: "A", invert: true },
  pen: { field: "C", invert: false },
};
// Poné esto en true SOLO después de confirmar con "probar campo A/B/C" que
// el mapeo de arriba es correcto. Mientras sea false, moveAxis/pen/sendPath
// solo loguean, no mueven nada.
let FIELD_MAP_CONFIRMED = true;

const MK_MAX = 0xffff; // techo del campo hex de 16 bits

// ============================================================
// MODELO DE MOVIMIENTO — CONFIRMADO empíricamente (no es posición):
// Los campos A y B son VELOCIDAD CON SIGNO centrada en 0x8000 (32768):
//   valor = 32768  -> motor QUIETO
//   valor < 32768  -> gira en un sentido (más lejos del centro = más rápido)
//   valor > 32768  -> gira en el sentido opuesto
// Confirmado: mandar A=8000 B=8000 frena ambos ejes.
// El lápiz (campo C) tiene su reposo en 0 y se maneja aparte (leva rotativa).
// ============================================================
// ============================================================
// MODELO DE VELOCIDAD — CORREGIDO leyendo la captura de nuevo:
// El reposo (quieto) es 0, NO 0x8000. El sentido se parte por 0x8000:
//   valor = 0                -> QUIETO (reposo, a donde vuelve al soltar)
//   valor 0x0001..0x7FFF     -> sentido "+" ; velocidad = valor
//   valor 0x8000..0xFFFF     -> sentido "-" ; velocidad = valor - 0x8000
// Confirmado: en la captura cada ráfaga se queda entera en una mitad y
// siempre vuelve a 0 al soltar. 0x8000 nunca aparece como "quieto".
// Para una velocidad v (1..32767) en un sentido:
//   sentido + :  frame = v
//   sentido - :  frame = 0x8000 + v
//   frenar    :  frame = 0
// ============================================================
const VEL_REST = 0x0000;        // reposo / quieto
const DIR_OFFSET = 0x8000;      // sumar esto = sentido opuesto
const VEL_MAX_MAG = 0x7000;     // magnitud máxima de velocidad usable (~28672)

/** Convierte (sentido, magnitud) al valor de campo correcto.
 * sign: +1 usa la mitad baja; -1 usa la mitad alta (0x8000+v). */
function velToField(sign, magnitude) {
  const m = Math.max(0, Math.min(VEL_MAX_MAG, Math.round(magnitude)));
  if (m === 0) return VEL_REST;
  return sign >= 0 ? m : (DIR_OFFSET + m);
}

// Magnitud de velocidad para el jog, por eje y sentido (ajustable en vivo).
const jogSpeed = {
  x: {
    pos: Number(localStorage.getItem("mk13181-js-xpos") || 8000),
    neg: Number(localStorage.getItem("mk13181-js-xneg") || 8000),
  },
  y: {
    pos: Number(localStorage.getItem("mk13181-js-ypos") || 8000),
    neg: Number(localStorage.getItem("mk13181-js-yneg") || 8000),
  },
};
const JOG_MS = 400;             // duración del pulso
const PEN_MS = 350;             // duración del pulso del lápiz (leva)
// Nota: el módulo mantiene la última velocidad hasta el próximo frame, por eso
// cada jog frena solo al final mandando 0 (reposo).

const penState = {
  up: Number(localStorage.getItem("mk13181-pen-up") || 1500),
  down: Number(localStorage.getItem("mk13181-pen-down") || 3000),
};

/** Construye un frame con los tres campos (velocidad A/B, lápiz C). */
function buildMoveFrame(a, b, c) {
  const h = (n) =>
    Math.max(0, Math.min(MK_MAX, Math.round(n)))
      .toString(16)
      .toUpperCase()
      .padStart(4, "0");
  return `T1440${h(a)}0${h(b)}0${h(c)}00000W`;
}

// Estado de velocidad actual de cada campo. A/B arrancan QUIETOS (centro),
// C (lápiz) arranca en su valor "arriba".
const machineVel = { A: VEL_REST, B: VEL_REST, C: VEL_REST };

// Posición ESTIMADA a lazo abierto (para mostrar y para fijar límites).
// Como el control es por velocidad+tiempo, esto es aproximado: cuenta cuánto
// nos movimos en cada pulso de jog. Sirve para calibrar extremos relativos.
const estPos = { x: 0, y: 0 };

function fieldFor(axis) {
  return FIELD_MAP[axis].field;
}

class MKBleAdapter {
  constructor() {
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth no está disponible en este navegador.");
    }

    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [MK_CONFIG.serviceUUID],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      this.connected = false;
      setBleUI(false);
      log("Dispositivo desconectado.");
    });

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(MK_CONFIG.serviceUUID);
    this.writeChar = await service.getCharacteristic(MK_CONFIG.writeCharUUID);
    this.notifyChar = await service.getCharacteristic(MK_CONFIG.notifyCharUUID);

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener("characteristicvaluechanged", (ev) =>
      this._handleNotify(ev)
    );

    this.connected = true;
    setBleUI(true);
    log(`Conectado: ${this.device.name || "dispositivo sin nombre"}`);

    await this._runHandshake();
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.connected = false;
    setBleUI(false);
  }

  async _runHandshake() {
    log("ejecutando secuencia de arranque capturada…");
    for (const cmd of MK_HANDSHAKE) {
      await this.sendRawCommand(cmd);
      await new Promise((r) => setTimeout(r, 80));
    }
    log("arranque enviado. Los siguientes comandos son experimentales — usá la consola.");
  }

  _handleNotify(event) {
    const bytes = new Uint8Array(event.target.value.buffer);
    let text;
    try {
      text = new TextDecoder("ascii").decode(bytes);
    } catch {
      text = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    }
    log(`< ${text}`);
    // La app oficial confirma cada notificación con un byte 0x01 crudo.
    // Se encola (no se escribe directo) para no chocar con otra escritura.
    this._writeRaw(new Uint8Array([0x01]));
  }

  // Cola serializada: Web Bluetooth NO permite dos escrituras en simultáneo
  // (da "GATT operation already in progress"). Encolamos todo y lo mandamos
  // de a uno, con un respiro y un reintento si falla.
  _enqueueWrite(bytes) {
    this._writeChain = (this._writeChain || Promise.resolve()).then(() =>
      this._doWrite(bytes)
    );
    return this._writeChain;
  }

  async _doWrite(bytes, attempt = 0) {
    if (!this.connected || !this.writeChar) {
      log("  (no enviado — sin conexión BLE activa)");
      return;
    }
    try {
      await this.writeChar.writeValueWithoutResponse(bytes);
      // respiro corto entre escrituras: el módulo pierde comandos si van muy
      // pegados (se ve en la captura ~80-100 ms entre frames).
      await new Promise((r) => setTimeout(r, 40));
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 120));
        return this._doWrite(bytes, attempt + 1);
      }
      log(`  error al escribir (tras reintentos): ${err.message}`);
    }
  }

  async _writeRaw(bytes) {
    return this._enqueueWrite(bytes);
  }

  /** Manda un comando de texto crudo, ya envuelto (p.ej. "T006W") tal cual
   * se vio en la captura. Usado por la consola manual y por el handshake. */
  async sendRawCommand(text) {
    log(`> ${text}`);
    await this._writeRaw(new TextEncoder().encode(text));
  }

  /** Emite un frame con las velocidades actuales de A/B y el valor del lápiz C. */
  async _emitFrame() {
    const frame = buildMoveFrame(machineVel.A, machineVel.B, machineVel.C);
    await this.sendRawCommand(frame);
  }

  /** Frena todos los motores: los tres campos a reposo (0). */
  async stopAll() {
    machineVel.A = VEL_REST;
    machineVel.B = VEL_REST;
    machineVel.C = VEL_REST;
    await this._emitFrame();
  }

  /** Prueba de identificación: da un pulso a UN campo (sentido +) y frena. */
  async probeField(field, ms = 500) {
    if (!this.connected) return log("conectá primero.");
    machineVel.A = VEL_REST; machineVel.B = VEL_REST; machineVel.C = VEL_REST;
    machineVel[field] = velToField(+1, 8000); // pulso sentido + a media velocidad
    log(`probando campo ${field} (mirá qué motor se mueve)`);
    await this._emitFrame();
    await new Promise((r) => setTimeout(r, ms));
    machineVel.A = VEL_REST; machineVel.B = VEL_REST; machineVel.C = VEL_REST;
    await this._emitFrame();
  }

  /** Jog SEGURO: pulso de duración fija y frena solo (reposo = 0).
   * El sentido se codifica con velToField (mitad baja / mitad alta). */
  async sendMove(axis, direction) {
    if (!FIELD_MAP_CONFIRMED) {
      log(`MOVE ${axis} dir=${direction} — confirmá FIELD_MAP primero. No se envía.`);
      return;
    }
    const { field, invert } = FIELD_MAP[axis];
    const sign = direction * (invert ? -1 : 1);
    const speed = direction > 0 ? jogSpeed[axis].pos : jogSpeed[axis].neg;
    machineVel[field] = velToField(sign, speed);
    await this._emitFrame();
    await new Promise((r) => setTimeout(r, JOG_MS));
    machineVel[field] = VEL_REST; // frenar
    await this._emitFrame();
    estPos[axis] += sign * 1;
  }

  /** Fija velocidad continua en un eje (para dibujo). No frena solo. */
  async setAxisVel(axis, sign, magnitude) {
    const { field, invert } = FIELD_MAP[axis];
    const s = invert ? -sign : sign;
    machineVel[field] = velToField(s, magnitude);
    await this._emitFrame();
  }

  async pen(up) {
    if (!FIELD_MAP_CONFIRMED) {
      log(`PEN ${up ? "UP" : "DOWN"} — confirmá FIELD_MAP primero. No se envía.`);
      return;
    }
    const { field } = FIELD_MAP.pen;
    // Reposo del lápiz = 0. "subir" = sentido -, "bajar" = sentido +.
    // penState guarda la magnitud de cada uno. Pulso corto y frena.
    machineVel[field] = up ? velToField(-1, penState.up) : velToField(+1, penState.down);
    await this._emitFrame();
    await new Promise((r) => setTimeout(r, PEN_MS));
    machineVel[field] = VEL_REST; // frenar la leva
    await this._emitFrame();
  }

  async sendPath(path) {
    // El control es por VELOCIDAD+TIEMPO a lazo abierto, así que un trazado
    // fiel todavía necesita calibrar cuántos ms = cuánta distancia. Por ahora
    // este envío queda deshabilitado para no dibujar cualquier cosa: primero
    // hay que resolver la conversión distancia->tiempo (ver nota en el chat).
    log("Envío de dibujo pausado: el control es por velocidad, falta calibrar tiempo↔distancia. El jog y el lápiz ya funcionan.");
  }
}

const ble = new MKBleAdapter();

function setBleUI(on) {
  $("status").textContent = on ? "BLE conectado" : "BLE desconectado";
  $("status").className = "status " + (on ? "online" : "offline");
  $("connectBtn").disabled = on;
  $("disconnectBtn").disabled = !on;
  $("sendBtn").disabled = !(on && state.path.length);
  if (on) unlockStep("stepCalibrate");
}

// --- Flujo por pasos: desbloquear / avanzar ---
function unlockStep(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("is-locked");
}
function scrollToStep(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// La posición es ESTIMADA a lazo abierto (el control es por velocidad, no hay
// feedback real). Cuenta pasos de jog. Sirve para fijar límites relativos.
function machineAxisValue(axis) {
  return estPos[axis];
}
function refreshPosLabels() {
  $("xpos").textContent = `X = ${machineAxisValue("x")}`;
  $("ypos").textContent = `Y = ${machineAxisValue("y")}`;
}

document.querySelectorAll("[data-jog]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const axis = btn.dataset.jog;
    const dir = Number(btn.dataset.dir);
    await ble.sendMove(axis, dir); // pulso de velocidad y frena
    refreshPosLabels();            // la UI refleja la posición real
  });
});

$("stopBtn").onclick = async () => {
  await ble.stopAll();
  log("FRENADO: ejes al centro.");
};

$("connectBtn").onclick = async () => {
  try { await ble.connect(); }
  catch (e) { log("Error BLE: " + e.message); }
};

$("disconnectBtn").onclick = () => ble.disconnect();

$("rawSendBtn").onclick = async () => {
  const text = $("rawCmd").value.trim();
  if (!text) return;
  await ble.sendRawCommand(text);
};
$("rawCmd").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("rawSendBtn").click();
});
document.querySelectorAll("[data-replay]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await ble.sendRawCommand(btn.dataset.replay);
  });
});
document.querySelectorAll("[data-probe]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await ble.probeField(btn.dataset.probe);
  });
});

$("penUp").onclick = async () => {
  state.pen = false; $("penState").textContent = "Arriba"; await ble.pen(true);
};
$("penDown").onclick = async () => {
  state.pen = true; $("penState").textContent = "Abajo"; await ble.pen(false);
};

// Deslizadores de velocidad por eje y sentido (para emparejar los lados
// rápido/lento). Se guardan y aplican en vivo.
function wireSpeedSlider(inputId, outId, axis, dir, storeKey) {
  const inp = $(inputId), out = $(outId);
  const val = jogSpeed[axis][dir];
  inp.value = val; out.textContent = val;
  inp.oninput = (e) => {
    const v = Number(e.target.value);
    jogSpeed[axis][dir] = v;
    out.textContent = v;
    localStorage.setItem(storeKey, v);
  };
}
wireSpeedSlider("xNegSpeed", "xNegOut", "x", "neg", "mk13181-js-xneg");
wireSpeedSlider("xPosSpeed", "xPosOut", "x", "pos", "mk13181-js-xpos");
wireSpeedSlider("yNegSpeed", "yNegOut", "y", "neg", "mk13181-js-yneg");
wireSpeedSlider("yPosSpeed", "yPosOut", "y", "pos", "mk13181-js-ypos");

// Deslizadores de calibración del lápiz (magnitud de velocidad de la leva).
$("penUpVal").value = penState.up;
$("penUpValOut").textContent = penState.up;
$("penDownVal").value = penState.down;
$("penDownValOut").textContent = penState.down;

$("penUpVal").oninput = async (e) => {
  penState.up = Number(e.target.value);
  $("penUpValOut").textContent = penState.up;
  localStorage.setItem("mk13181-pen-up", penState.up);
  if (!state.pen) await ble.pen(true); // si está arriba, mostrar el cambio ya
};
$("penDownVal").oninput = async (e) => {
  penState.down = Number(e.target.value);
  $("penDownValOut").textContent = penState.down;
  localStorage.setItem("mk13181-pen-down", penState.down);
  if (state.pen) await ble.pen(false); // si está abajo, mostrar el cambio ya
};

function loadCalibration() {
  const c = JSON.parse(localStorage.getItem("mk13181-calibration") || "null");
  if (!c) return;
  state.limits = c.limits || state.limits;
  state.pos = c.pos || state.pos;
  $("xmin").value = state.limits.x[0];
  $("xmax").value = state.limits.x[1];
  $("ymin").value = state.limits.y[0];
  $("ymax").value = state.limits.y[1];
  refreshPosLabels();
  // Ya hay calibración previa: destrabar el paso de dibujo desde el arranque.
  unlockStep("stepImage");
}
// Botones "Fijar mín/máx": toman la posición actual del eje y la ponen en el
// campo correspondiente. Así no tenés que anotar números a mano.
document.querySelectorAll("[data-fix]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.fix; // xmin | xmax | ymin | ymax
    const axis = target[0];         // x | y
    const val = machineAxisValue(axis);
    $(target).value = val;
    log(`${target} fijado en ${val}`);
  });
});

function saveCalibration() {
  state.limits.x = [Number($("xmin").value), Number($("xmax").value)];
  state.limits.y = [Number($("ymin").value), Number($("ymax").value)];
  localStorage.setItem("mk13181-calibration", JSON.stringify({
    limits: state.limits, pos: state.pos
  }));
  log("Calibración guardada.");
  $("calibOk").hidden = false;
  unlockStep("stepImage");
  scrollToStep("stepImage");
}
$("saveCalibration").onclick = saveCalibration;
$("resetCalibration").onclick = () => {
  localStorage.removeItem("mk13181-calibration");
  location.reload();
};
loadCalibration();

const canvas = $("preview");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

$("imageInput").onchange = e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    state.image = img;
    drawPreview();
    $("vectorizeBtn").disabled = false;
    log(`Imagen cargada: ${img.width} × ${img.height}`);
  };
  img.src = URL.createObjectURL(file);
};

$("threshold").oninput = e => {
  $("thresholdValue").textContent = e.target.value;
  drawPreview();
};
$("scale").oninput = e => {
  $("scaleValue").textContent = e.target.value + "%";
  drawPreview();
};

function drawPreview() {
  if (!state.image) return;
  const img = state.image;
  const maxW = 600, maxH = 400;
  const s = Math.min(maxW / img.width, maxH / img.height, 1);
  canvas.width = Math.max(1, Math.round(img.width * s));
  canvas.height = Math.max(1, Math.round(img.height * s));
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

function makeRasterPath() {
  // Vectorizador simple: barre píxeles oscuros y agrupa corridas horizontales.
  // Ahora emite coordenadas de MÁQUINA (campos a/b en 0..65535) mapeadas al
  // rango calibrado de cada eje, así sendPath las manda directo.
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  const threshold = Number($("threshold").value);
  const scale = Number($("scale").value) / 100;
  const path = [];

  // Rango de máquina por eje, tomado de la calibración guardada. Si el
  // usuario todavía no calibró en unidades de máquina, usamos el rango
  // observado en la captura como valor por defecto conservador.
  const ax0 = state.limits.x[0], ax1 = state.limits.x[1];
  const ay0 = state.limits.y[0], ay1 = state.limits.y[1];
  const toA = (px) => ax0 + (px / w) * (ax1 - ax0) * scale;
  const toB = (py) => ay0 + (py / h) * (ay1 - ay0) * scale;

  for (let y = 0; y < h; y += 2) {
    let start = null;
    for (let x = 0; x <= w; x++) {
      let dark = false;
      if (x < w) {
        const i = (y * w + x) * 4;
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        dark = lum < threshold;
      }
      if (dark && start === null) start = x;
      if ((!dark || x === w) && start !== null) {
        if (x - start >= 2) {
          path.push({ type: "move", a: toA(start), b: toB(y) });
          path.push({ type: "pen", down: true });
          path.push({ type: "move", a: toA(x - 1), b: toB(y) });
          path.push({ type: "pen", down: false });
        }
        start = null;
      }
    }
  }
  return path;
}

$("vectorizeBtn").onclick = () => {
  state.path = makeRasterPath();
  $("plotInfo").textContent = `${state.path.length} comandos preparados.`;
  $("simulateBtn").disabled = !state.path.length;
  $("sendBtn").disabled = !(ble.connected && state.path.length);
  log(`Trazado preparado: ${state.path.length} comandos.`);
  if (state.path.length) {
    unlockStep("stepSend");
    scrollToStep("stepSend");
  }
};

$("simulateBtn").onclick = async () => {
  log("Simulación iniciada.");
  for (const p of state.path.slice(0, 300)) {
    if (p.type === "pen") state.pen = p.down;
    else state.pos = { x: p.a, y: p.b };
    await new Promise(r => setTimeout(r, 5));
  }
  log("Simulación terminada.");
};

$("sendBtn").onclick = async () => {
  if (!ble.connected) return;
  await ble.sendPath(state.path);
  log("Fin del envío (actualmente modo placeholder).");
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(console.error);
}
