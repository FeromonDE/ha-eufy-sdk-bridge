// The host-facing view of a device: identity + capabilities + live property values + a stream path for
// cameras. This is the shape the WS `devices.list` / `device.state` / `device.properties` commands and
// the go2rtc camera registration both read, so a camera is "a device describeDevice gave a `stream`",
// not `deviceClass === "camera"` (the SDK downgrades a camera behind a HomeBase to "other").

export function createDeviceView(ctx) {
  const { eufy } = ctx;
  const { streaming } = ctx.state;

  // EufyMega intentionally keeps handed-out Device objects only through WeakRef. The host must retain
  // them if it expects realtime state (propertyChanged / refresh-backed semantic events) to keep landing.
  // Keeping one canonical Device per serial also avoids a cloud-backed getDevice() on every host read.
  const devices = new Map();
  const pendingDevices = new Map();

  async function deviceFor(sn) {
    const held = devices.get(sn);
    if (held) return held;
    const pending = pendingDevices.get(sn);
    if (pending) return pending;

    const load = eufy
      .getDevice(sn)
      .then((dev) => {
        devices.set(sn, dev);
        pendingDevices.delete(sn);
        return dev;
      })
      .catch((err) => {
        pendingDevices.delete(sn);
        throw err;
      });
    pendingDevices.set(sn, load);
    return load;
  }

  function cachedDevice(sn) {
    return devices.get(sn);
  }

  function enrichDeviceEvent(event, payload = {}) {
    if (event !== "armingModeChanged" || payload.mode !== undefined) return payload;
    const sn = payload.deviceSn ?? payload.sn;
    const sdkMode = cachedDevice(sn)?.getProperty?.("armingMode")?.value;
    const mode = ctx.armingModeOverride?.(sn, sdkMode) ?? sdkMode;
    return mode === undefined ? payload : { ...payload, mode };
  }

  /**
   * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
   *
   * `name` is the owner's device name (falling back to the product name when unnamed), `model` is the
   * T-code, `modelName` is the product. A host shows `name` as the device name and `model`/`modelName`
   * as its model — no cross-referencing the device list.
   */
  async function describeDevice(sn) {
    const dev = await deviceFor(sn);
    const m = dev.describe();
    const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
    const state = propertyState(dev);
    const modeOverride = ctx.armingModeOverride?.(m.sn, state.armingMode);
    if (modeOverride !== undefined) state.armingMode = modeOverride;
    return {
      sn: m.sn,
      name: m.name, // owner's device name (e.g. "Dining room"), from device_name
      model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
      modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
      codec: m.codec,
      capabilities: m.capabilities,
      state, // live property values ({ battery: 74, motion: false, … })
      stream: isCamera ? `/stream/${m.sn}` : undefined,
      streaming: isCamera ? streaming.has(m.sn) : undefined, // live P2P feed active right now?
      canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
    };
  }

  /** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
  function propertyState(dev) {
    const out = {};
    for (const [name, pv] of Object.entries(dev.getProperties())) out[name] = pv.value;
    return out;
  }

  /**
   * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
   * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
   * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
   */
  function propertySpecs(dev) {
    return (dev.properties ?? []).map((p) => ({
      name: p.name,
      type: p.type, // "bool" | "number" | "string" | "enum"
      unit: p.unit, // "%", "°C", "dBm", …
      kind: p.kind, // percent | celsius | dbm | seconds | …
      writable: p.writable, // a setter exists (device.set accepts it)
      enumValues: p.enumValues, // { raw: label } for enums
      description: p.description,
    }));
  }

  async function deviceList() {
    const devices = await eufy.getDevices();
    return Promise.all(
      devices.map((d) => describeDevice(d.sn).catch((e) => ({ sn: d.sn, error: String(e?.message ?? e) }))),
    );
  }

  return {
    deviceFor,
    cachedDevice,
    enrichDeviceEvent,
    describeDevice,
    propertyState,
    propertySpecs,
    deviceList,
  };
}
