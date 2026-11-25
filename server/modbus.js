// Een heel kleine Modbus TCP-client: genoeg om holding registers te lezen (functie 0x03).
// Geen dependency nodig. Eén verbinding die open blijft, en verzoeken die netjes na elkaar gaan:
// een Huawei-dongle verdraagt maar een paar verbindingen tegelijk en houdt niet van haast.
import net from 'node:net';

const EXCEPTIONS = {
  1: 'ongeldige functie',
  2: 'ongeldig registeradres',
  3: 'ongeldige waarde',
  4: 'fout in het toestel',
  6: 'toestel bezig',
  11: 'toestel antwoordt niet (gateway)',
};

export class ModbusError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port=502]
 * @param {number} [opts.unit=1]         Modbus-adres (slave id) van het toestel
 * @param {number} [opts.timeout=10000]  ms per verzoek (een SDongle kan traag antwoorden)
 * @param {number} [opts.settle=1000]    ms wachten na het verbinden (Huawei wil even tijd)
 * @param {number} [opts.cooldown=50]    ms rust tussen twee verzoeken
 * @param {number} [opts.idleClose=60000] verbinding sluiten na zoveel ms zonder verzoek
 */
export function createModbusClient({ host, port = 502, unit = 1, timeout = 10_000, settle = 1000, cooldown = 50, idleClose = 60_000 }) {
  let socket = null;
  let connecting = null;
  let buffer = Buffer.alloc(0);
  let tid = 0;
  let pending = null; // { id, resolve, reject, timer }
  let queue = Promise.resolve();
  let idleTimer = null;

  function drop(err) {
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    }
    socket = null;
    connecting = null;
    buffer = Buffer.alloc(0);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err ?? new ModbusError('Verbinding verbroken.'));
      pending = null;
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    // MBAP-kop: transactie (2), protocol (2), lengte (2), unit (1); daarna de PDU.
    while (buffer.length >= 7) {
      const length = buffer.readUInt16BE(4);
      const total = 6 + length;
      if (buffer.length < total) return;
      const frame = buffer.subarray(0, total);
      buffer = buffer.subarray(total);
      const id = frame.readUInt16BE(0);
      if (!pending || pending.id !== id) continue; // een laat antwoord op een verzoek dat al verlopen is
      const fn = frame[7];
      const { resolve, reject, timer } = pending;
      pending = null;
      clearTimeout(timer);
      if (fn & 0x80) {
        const code = frame[8];
        reject(new ModbusError(`Modbus-fout ${code}: ${EXCEPTIONS[code] ?? 'onbekend'}`, code));
      } else {
        const bytes = frame[8];
        resolve(frame.subarray(9, 9 + bytes));
      }
    }
  }

  function connect() {
    if (socket && !socket.destroyed && !connecting) return Promise.resolve();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      socket = s;
      const fail = (err) => {
        drop(err);
        reject(new ModbusError(`Kan ${host}:${port} niet bereiken (${err.code ?? err.message}).`));
      };
      s.setTimeout(timeout, () => fail(new Error('time-out')));
      s.once('error', fail);
      s.once('connect', () => {
        s.setTimeout(0);
        s.removeListener('error', fail);
        s.on('error', (err) => drop(new ModbusError(`Verbinding verbroken (${err.code ?? err.message}).`)));
        s.on('close', () => drop());
        s.on('data', onData);
        s.setKeepAlive(true, 30_000);
        setTimeout(() => {
          connecting = null;
          resolve();
        }, settle);
      });
    });
    return connecting;
  }

  function request(address, count) {
    return new Promise((resolve, reject) => {
      tid = (tid + 1) & 0xffff;
      const frame = Buffer.alloc(12);
      frame.writeUInt16BE(tid, 0);
      frame.writeUInt16BE(0, 2);
      frame.writeUInt16BE(6, 4);
      frame.writeUInt8(unit, 6);
      frame.writeUInt8(0x03, 7);
      frame.writeUInt16BE(address, 8);
      frame.writeUInt16BE(count, 10);
      const timer = setTimeout(() => {
        pending = null;
        // Na een time-out kan er nog een antwoord onderweg zijn; opnieuw verbinden is het veiligst.
        drop(new ModbusError(`Geen antwoord op register ${address} binnen ${timeout / 1000} s.`));
        reject(new ModbusError(`Geen antwoord op register ${address} binnen ${timeout / 1000} s.`));
      }, timeout);
      pending = { id: tid, resolve, reject, timer };
      socket.write(frame);
    });
  }

  /** Leest `count` holding registers vanaf `address`. Geeft de ruwe bytes terug (2 per register). */
  function read(address, count) {
    const job = queue.then(async () => {
      clearTimeout(idleTimer);
      await connect();
      try {
        return await request(address, count);
      } finally {
        await new Promise((r) => setTimeout(r, cooldown));
        idleTimer = setTimeout(() => drop(), idleClose);
        idleTimer.unref?.();
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  return { read, close: () => drop() };
}
