// Construct WebSocket URL relative to current location for ingress compatibility
const basePath = location.pathname.replace(/\/$/, '');
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProtocol}://${location.host}${basePath}/ws`);

const CELL_PX = 34;
const FIXTURE_LABEL_WIDTH = 190;
const TAP_RESET_IDLE_MS = 2000;
const MOBILE_BREAKPOINT_PX = 980;

const programSelect = document.getElementById("programSelect");
const createProgramBtn = document.getElementById("createProgramBtn");
const deleteProgramBtn = document.getElementById("deleteProgramBtn");
const seekStartBtn = document.getElementById("seekStartBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const seekEndBtn = document.getElementById("seekEndBtn");
const blackoutBtn = document.getElementById("blackoutBtn");
const loopInput = document.getElementById("loopInput");
const spmDownBtn = document.getElementById("spmDownBtn");
const tapSyncBtn = document.getElementById("tapSyncBtn");
const spmUpBtn = document.getElementById("spmUpBtn");
const spmInput = document.getElementById("spmInput");
const spmMultiplierSelect = document.getElementById("spmMultiplierSelect");
const fadeMsInput = document.getElementById("fadeMsInput");
const mobileTabPlaybackBtn = document.getElementById("mobileTabPlaybackBtn");
const mobileTabSequencerBtn = document.getElementById("mobileTabSequencerBtn");
const mobileProgramGrid = document.getElementById("mobileProgramGrid");
const layerModeSwitch = document.getElementById("layerModeSwitch");

const stepGrid = document.getElementById("stepGrid");
const palette = document.getElementById("palette");
const simulator = document.getElementById("simulator");
const roomCanvas = document.getElementById("roomCanvas");

const canvas = /** @type {HTMLCanvasElement} */ (roomCanvas);
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D canvas context not available");

const state = {
  programs: [],
  config: { fixtures: [], environments: [] },
  colorPresets: [],
  selectedProgramId: null,
  runningProgramId: null,
  timelineSteps: 100,
  currentPlayheadStep: 0,
  isPlaying: false,
  isBlackout: false,
  canvasWidthCss: 1,
  canvasHeightCss: 1,
  lastFrame: null,
  paletteFeatureValues: {},
  rgbBaseColorByKey: {},
  rgbBrightnessByKey: {},
  selectedPaletteKey: null,
  paletteLayer: "B",
  drawTool: "pencil",
  painting: false,
  lastPaintKey: null,
  saveInFlight: false,
  savePending: false,
  saveTimerId: null,
  liveSyncTimerId: null,
  editVersion: 0,
  lastSavedVersion: 0,
  tapSyncActive: false,
  tapSyncSpm: null,
  tapTimesMs: [],
  mobileTab: localStorage.getItem("mobileTab") === "sequencer" ? "sequencer" : "playback",
};

const defaultColorPresets = [
  { name: "Red", rgb: [255, 0, 0] },
  { name: "Green", rgb: [0, 255, 0] },
  { name: "Blue", rgb: [0, 0, 255] },
  { name: "Warm White", rgb: [255, 214, 170] },
  { name: "Cold White", rgb: [200, 228, 255] },
];

function send(event) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

function isMobileLayout() {
  return window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

function applyMobileTabUi() {
  document.body.classList.remove("mobile-tab-playback", "mobile-tab-sequencer");
  if (!isMobileLayout()) return;
  if (state.mobileTab !== "sequencer") state.mobileTab = "playback";
  document.body.classList.add(
    state.mobileTab === "sequencer" ? "mobile-tab-sequencer" : "mobile-tab-playback",
  );
}

function setMobileTab(tab) {
  state.mobileTab = tab === "sequencer" ? "sequencer" : "playback";
  localStorage.setItem("mobileTab", state.mobileTab);
  applyMobileTabUi();
}

function markProgramDirty() {
  state.editVersion += 1;
}

async function loadColorPresets() {
  try {
    const response = await fetch("./color-presets.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Preset load failed: ${response.status}`);
    const parsed = await response.json();
    if (!Array.isArray(parsed)) throw new Error("Preset file is not an array");

    const valid = parsed
      .filter((item) =>
        item
        && typeof item.name === "string"
        && Array.isArray(item.rgb)
        && item.rgb.length === 3,
      )
      .map((item) => ({
        name: item.name,
        rgb: [
          clamp255(item.rgb[0]),
          clamp255(item.rgb[1]),
          clamp255(item.rgb[2]),
        ],
      }));

    state.colorPresets = valid.length > 0 ? valid : defaultColorPresets;
  } catch {
    state.colorPresets = defaultColorPresets;
  }
}

function selectedProgram() {
  return state.programs.find((program) => program.id === state.selectedProgramId) || null;
}

function selectedEnvironment() {
  const program = selectedProgram();
  if (!program) return null;
  return state.config.environments.find((env) => env.id === program.environmentId) || null;
}

function fixtureDefinition(fixtureTypeId) {
  return state.config.fixtures.find((fixture) => fixture.id === fixtureTypeId) || null;
}

function getStep(stepIndex) {
  const program = selectedProgram();
  if (!program) return null;
  return program.steps[stepIndex] || null;
}

function ensureStepExists(stepIndex) {
  const program = selectedProgram();
  if (!program) return null;

  while (program.steps.length <= stepIndex) {
    const index = program.steps.length;
    const prev = index > 0 ? program.steps[index - 1] : null;
    program.steps.push({
      id: `step-${index + 1}`,
      durationMs: prev?.durationMs ?? 500,
      fadeMs: prev?.fadeMs ?? 300,
      frames: [],
    });
  }

  return program.steps[stepIndex];
}

function getFixtureFramesForStep(step, fixtureId) {
  return step.frames.filter((frame) => frame.fixtureId === fixtureId);
}

function frameValueToArray(value) {
  return Array.isArray(value) ? value : [value];
}

function normalizeByFeature(feature, values) {
  return feature.channels.length === 1 ? values[0] : values;
}

function clamp255(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(255, Math.round(parsed)));
}

function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ");
}

function clampFadeMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(10000, Math.round(parsed)));
}

function clampSpm(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 120;
  return Math.max(1, Math.min(500, Math.round(parsed)));
}

function applyBaseSpmChange(baseSpm) {
  const clamped = clampSpm(baseSpm);
  spmInput.value = String(clamped);
  deactivateTapSync();
  const program = selectedProgram();
  if (program) {
    program.spm = clamped;
    markProgramDirty();
    scheduleAutoSave();
  }
  send({ type: "tempo", payload: { spm: effectiveSpmFromBase(clamped) } });
}

function currentSpmMultiplier() {
  const parsed = Number(spmMultiplierSelect.value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, parsed);
}

function effectiveSpmFromBase(baseSpm) {
  return clampSpm(clampSpm(baseSpm) * currentSpmMultiplier());
}

function isLoopEnabled() {
  return loopInput.classList.contains("active-tool");
}

function setLoopEnabled(enabled) {
  loopInput.classList.toggle("active-tool", Boolean(enabled));
  loopInput.setAttribute("aria-pressed", String(Boolean(enabled)));
}

function effectiveSpmForControls(program) {
  if (state.tapSyncActive && state.tapSyncSpm !== null) {
    return state.tapSyncSpm;
  }
  if (state.lastFrame?.state?.spm) {
    return clampSpm(state.lastFrame.state.spm / currentSpmMultiplier());
  }
  if (Number.isFinite(Number(spmInput.value))) {
    return clampSpm(Number(spmInput.value));
  }
  return program?.spm ?? 120;
}

function setTapSyncSpm(spm) {
  const clamped = clampSpm(spm);
  state.tapSyncSpm = clamped;
  state.tapSyncActive = true;
  return clamped;
}

function clearTapSync() {
  state.tapSyncActive = false;
  state.tapSyncSpm = null;
  state.tapTimesMs = [];
}

function updateTapSyncUi() {
  if (state.tapSyncActive) {
    tapSyncBtn.classList.add("active-tool");
    tapSyncBtn.textContent = "Tap";
  } else {
    tapSyncBtn.classList.remove("active-tool");
    tapSyncBtn.textContent = "Tap";
  }
}

function deactivateTapSync() {
  clearTapSync();
  updateTapSyncUi();
}

function applySpmOverride(spm, restart = false) {
  const baseSpm = setTapSyncSpm(spm);
  spmInput.value = String(baseSpm);
  send({ type: "tempo", payload: { spm: effectiveSpmFromBase(baseSpm) } });
  if (restart) send({ type: "seek", payload: { stepIndex: 0 } });
  updateTapSyncUi();
}

function handleTapSync() {
  const nowMs = Date.now();
  const lastTapMs = state.tapTimesMs[state.tapTimesMs.length - 1];
  if (lastTapMs !== undefined && nowMs - lastTapMs > TAP_RESET_IDLE_MS) {
    state.tapTimesMs = [];
  }
  state.tapTimesMs.push(nowMs);
  if (state.tapTimesMs.length > 8) state.tapTimesMs.shift();

  const intervals = [];
  for (let i = 1; i < state.tapTimesMs.length; i += 1) {
    intervals.push(state.tapTimesMs[i] - state.tapTimesMs[i - 1]);
  }

  const computedSpm = intervals.length > 0
    ? clampSpm(60000 / (intervals.reduce((sum, item) => sum + item, 0) / intervals.length))
    : clampSpm(Number(spmInput.value));

  applySpmOverride(computedSpm, true);
}

function addStepToProgram() {
  const program = selectedProgram();
  if (!program) return false;
  const index = program.steps.length;
  const prev = index > 0 ? program.steps[index - 1] : null;
  program.steps.push({
    id: `step-${index + 1}`,
    durationMs: prev?.durationMs ?? 500,
    fadeMs: prev?.fadeMs ?? 300,
    frames: [],
  });
  state.timelineSteps = Math.max(1, program.steps.length);
  return true;
}

function removeStepFromProgram(stepIndex) {
  const program = selectedProgram();
  if (!program) return false;
  if (program.steps.length <= 1) return false;
  if (stepIndex < 0 || stepIndex >= program.steps.length) return false;

  program.steps.splice(stepIndex, 1);
  for (let i = 0; i < program.steps.length; i += 1) {
    program.steps[i].id = `step-${i + 1}`;
  }

  state.timelineSteps = Math.max(1, program.steps.length);
  if (state.currentPlayheadStep >= program.steps.length) {
    state.currentPlayheadStep = Math.max(0, program.steps.length - 1);
    send({ type: "seek", payload: { stepIndex: state.currentPlayheadStep } });
  }
  return true;
}

function updatePlayPauseLabel() {
  playPauseBtn.textContent = state.isPlaying ? "Pause" : "Play";
}

function updateBlackoutUi() {
  blackoutBtn.classList.toggle("active-tool", state.isBlackout);
}

function fillProgramSelect() {
  const previous = state.selectedProgramId;
  programSelect.innerHTML = "";

  for (const program of state.programs) {
    const option = document.createElement("option");
    option.value = program.id;
    option.textContent = program.name;
    programSelect.appendChild(option);
  }

  const running = state.runningProgramId;
  if (running && state.programs.some((program) => program.id === running)) {
    state.selectedProgramId = running;
  } else if (previous && state.programs.some((program) => program.id === previous)) {
    state.selectedProgramId = previous;
  } else {
    state.selectedProgramId = state.programs[0]?.id || null;
  }

  programSelect.value = state.selectedProgramId || "";
  const program = selectedProgram();
  if (program) state.timelineSteps = Math.max(1, program.steps.length || 1);
  setLoopEnabled(Boolean(program?.loop ?? true));
  const effectiveSpm = effectiveSpmForControls(program);
  spmInput.value = String(effectiveSpm);
  const fadeMs = clampFadeMs(program?.steps?.[0]?.fadeMs ?? 300);
  fadeMsInput.value = String(fadeMs);
  updateTapSyncUi();
  renderLayerModeSwitch();
  renderMobileProgramGrid();
}

function renderMobileProgramGrid() {
  if (!mobileProgramGrid) return;
  mobileProgramGrid.innerHTML = "";
  for (const program of state.programs) {
    const button = document.createElement("button");
    button.className = "mobile-program-btn";
    if (program.id === state.selectedProgramId) button.classList.add("active");
    button.textContent = program.name;
    button.onclick = () => selectProgram(program.id);
    mobileProgramGrid.appendChild(button);
  }
}

function activateSelectedProgram(programId) {
  send({ type: "program", payload: { programId } });
  if (!state.isPlaying) {
    send({ type: "play" });
  }
}

function selectProgram(programId) {
  state.selectedProgramId = programId;
  const program = selectedProgram();
  if (!program) return;
  programSelect.value = program.id;

  state.timelineSteps = Math.max(1, program.steps.length || 1);
  setLoopEnabled(Boolean(program.loop ?? true));
  spmInput.value = String(effectiveSpmForControls(program));
  fadeMsInput.value = String(clampFadeMs(program.steps?.[0]?.fadeMs ?? 300));
  if (!state.isPlaying || state.currentPlayheadStep >= program.steps.length) {
    state.currentPlayheadStep = 0;
  }
  renderPalette();
  renderStepGrid();
  renderMobileProgramGrid();
  if (state.lastFrame) drawSimulator(state.lastFrame);
  activateSelectedProgram(program.id);
}

function layoutRoomCanvas(environment) {
  const simulatorRect = simulator.getBoundingClientRect();
  const roomRatio = environment.dimensionsMm.height / environment.dimensionsMm.width;

  let width = simulatorRect.width - 2;
  let height = width / roomRatio;
  if (height > simulatorRect.height - 2) {
    height = simulatorRect.height - 2;
    width = height * roomRatio;
  }

  const cssW = Math.max(1, width);
  const cssH = Math.max(1, height);
  state.canvasWidthCss = cssW;
  state.canvasHeightCss = cssH;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fixtureColor(values, fixtureId, fixtureDef) {
  let rgb = [0, 0, 0];
  let cct = [0, 0];
  let dimmerLevel = 0;

  for (const [key, value] of Object.entries(values)) {
    const [keyFixtureId, featureId] = key.split(":");
    if (keyFixtureId !== fixtureId) continue;

    const feature = fixtureDef.features.find((item) => item.id === featureId);
    if (!feature) continue;

    const array = Array.isArray(value) ? value : [value];
    if (feature.kind === "rgb") rgb = [array[0] || 0, array[1] || 0, array[2] || 0];
    if (feature.kind === "cct") cct = [array[0] || 0, array[1] || 0];
    if (feature.kind === "scalar") dimmerLevel = Math.max(dimmerLevel, clamp255(array[0] || 0));
  }

  const warm = cct[0];
  const cool = cct[1];
  const whiteR = Math.round((warm * 255 + cool * 180) / 255);
  const whiteG = Math.round((warm * 170 + cool * 220) / 255);
  const whiteB = Math.round((warm * 100 + cool * 255) / 255);

  const dimmerColor = fixtureDef.dimmerColorRgb ?? [255, 255, 255];
  const dimmerR = Math.round((dimmerColor[0] * dimmerLevel) / 255);
  const dimmerG = Math.round((dimmerColor[1] * dimmerLevel) / 255);
  const dimmerB = Math.round((dimmerColor[2] * dimmerLevel) / 255);

  const r = Math.min(255, rgb[0] + whiteR + dimmerR);
  const g = Math.min(255, rgb[1] + whiteG + dimmerG);
  const b = Math.min(255, rgb[2] + whiteB + dimmerB);
  return `rgb(${r}, ${g}, ${b})`;
}

function drawSimulator(frame) {
  const environment = selectedEnvironment();
  if (!environment) return;

  layoutRoomCanvas(environment);

  ctx.clearRect(0, 0, state.canvasWidthCss, state.canvasHeightCss);
  ctx.fillStyle = "#020202";
  ctx.fillRect(0, 0, state.canvasWidthCss, state.canvasHeightCss);

  for (const fixture of environment.fixtures) {
    const def = fixtureDefinition(fixture.fixtureTypeId);
    if (!def) continue;

    const fallbackCx = (fixture.position2d.x / environment.dimensionsMm.height) * state.canvasWidthCss;
    const fallbackCy = (fixture.position2d.y / environment.dimensionsMm.width) * state.canvasHeightCss;
    const fallbackW = (def.dimensionsMm.width / environment.dimensionsMm.height) * state.canvasWidthCss;
    const fallbackH = (def.dimensionsMm.height / environment.dimensionsMm.width) * state.canvasHeightCss;

    const cx = fallbackCx;
    const cy = fallbackCy;
    const baseW = fallbackW;
    const baseH = fallbackH;

    const angle = ((Number(fixture.orientationDeg ?? 0) - 90) * Math.PI) / 180;
    const fill = fixtureColor(frame.values, fixture.id, def);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = fill;
    ctx.fillRect(-baseW / 2, -baseH / 2, baseW, baseH);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.strokeRect(-baseW / 2, -baseH / 2, baseW, baseH);
    ctx.restore();
  }
}

function keyframeValues(step, fixtureId) {
  const values = {};
  if (!step) return values;
  const frames = getFixtureFramesForStep(step, fixtureId);
  for (const frame of frames) {
    values[`${fixtureId}:${frame.featureId}`] = frameValueToArray(frame.value);
  }
  return values;
}

function defaultFeatureValues(feature) {
  if (feature.kind === "rgb") return [0, 0, 0];
  return Array.from({ length: feature.channels.length }, () => 0);
}

function applyRgbBrightness(baseRgb, brightness) {
  const scale = Math.max(0, Math.min(255, Number(brightness))) / 255;
  return [
    clamp255(baseRgb[0] * scale),
    clamp255(baseRgb[1] * scale),
    clamp255(baseRgb[2] * scale),
  ];
}

function featureOptions() {
  const options = [];
  for (const fixtureType of state.config.fixtures) {
    for (const feature of fixtureType.features) {
      const key = `${fixtureType.id}::${feature.id}`;
      options.push({
        key,
        fixtureTypeId: fixtureType.id,
        fixtureTypeName: fixtureType.name,
        feature,
      });
    }
  }
  return options;
}

function setPaletteLayer(layer) {
  const next = layer === "A" ? "A" : "B";
  if (state.paletteLayer === next) return;
  state.paletteLayer = next;
  renderLayerModeSwitch();
  renderStepGrid();
  renderPalette();
}

function renderLayerModeSwitch() {
  if (!layerModeSwitch) return;
  layerModeSwitch.innerHTML = "";

  const staticBtn = document.createElement("button");
  staticBtn.type = "button";
  staticBtn.textContent = "Static";
  if (state.paletteLayer === "A") staticBtn.classList.add("active-tool");
  staticBtn.onclick = () => setPaletteLayer("A");

  const sequencerBtn = document.createElement("button");
  sequencerBtn.type = "button";
  sequencerBtn.textContent = "Sequencer";
  if (state.paletteLayer === "B") sequencerBtn.classList.add("active-tool");
  sequencerBtn.onclick = () => setPaletteLayer("B");

  layerModeSwitch.appendChild(staticBtn);
  layerModeSwitch.appendChild(sequencerBtn);
}

function renderPalette() {
  palette.innerHTML = "";

  const options = featureOptions();
  if (options.length === 0) return;

  if (!state.selectedPaletteKey || !options.some((option) => option.key === state.selectedPaletteKey)) {
    state.selectedPaletteKey = options[0].key;
  }

  const layout = document.createElement("div");
  layout.className = "palette-layout";

  const tools = document.createElement("div");
  tools.className = "palette-modes";
  const pencilBtn = document.createElement("button");
  pencilBtn.textContent = "Pencil";
  const eraserBtn = document.createElement("button");
  eraserBtn.textContent = "Eraser";
  const pickerBtn = document.createElement("button");
  pickerBtn.textContent = "Picker";

  if (state.drawTool === "pencil") pencilBtn.classList.add("active-tool");
  if (state.drawTool === "eraser") eraserBtn.classList.add("active-tool");
  if (state.drawTool === "picker") pickerBtn.classList.add("active-tool");

  pencilBtn.onclick = () => {
    state.drawTool = "pencil";
    renderPalette();
  };
  eraserBtn.onclick = () => {
    state.drawTool = "eraser";
    renderPalette();
  };
  pickerBtn.onclick = () => {
    state.drawTool = "picker";
    renderPalette();
  };

  tools.appendChild(pencilBtn);
  tools.appendChild(eraserBtn);
  tools.appendChild(pickerBtn);
  layout.appendChild(tools);

  const config = document.createElement("div");
  config.className = "palette-config";
  layout.appendChild(config);
  palette.appendChild(layout);

  if (state.drawTool !== "pencil") return;

  const select = document.createElement("select");
  const groupedOptions = new Map();
  for (const option of options) {
    const list = groupedOptions.get(option.fixtureTypeName) ?? [];
    list.push(option);
    groupedOptions.set(option.fixtureTypeName, list);
  }
  for (const [fixtureTypeName, groupOptions] of groupedOptions) {
    const group = document.createElement("optgroup");
    group.label = fixtureTypeName;
    for (const option of groupOptions) {
      const el = document.createElement("option");
      el.value = option.key;
      el.textContent = option.feature.label;
      group.appendChild(el);
    }
    select.appendChild(group);
  }
  select.value = state.selectedPaletteKey;
  select.disabled = state.drawTool === "eraser";
  select.onchange = () => {
    state.selectedPaletteKey = select.value;
    renderPalette();
  };
  config.appendChild(select);

  const active = options.find((option) => option.key === state.selectedPaletteKey);
  if (!active) return;

  if (!state.paletteFeatureValues[active.key]) {
    state.paletteFeatureValues[active.key] = defaultFeatureValues(active.feature);
  }
  const values = state.paletteFeatureValues[active.key];

  const card = document.createElement("div");
  card.className = "palette-feature";

  const name = document.createElement("div");
  name.className = "palette-feature-name";
  name.textContent = active.feature.label;
  card.appendChild(name);

  if (active.feature.kind === "rgb") {
    if (!state.rgbBaseColorByKey[active.key]) {
      const [r = 0, g = 0, b = 0] = values;
      state.rgbBaseColorByKey[active.key] = [clamp255(r), clamp255(g), clamp255(b)];
    }
    if (!Number.isFinite(state.rgbBrightnessByKey[active.key])) {
      state.rgbBrightnessByKey[active.key] = 255;
    }

    const brightnessWrap = document.createElement("label");
    brightnessWrap.className = "feature-input-row";
    const brightnessLabel = document.createElement("span");
    brightnessLabel.textContent = "Brightness";
    const brightnessControl = document.createElement("div");
    brightnessControl.style.display = "grid";
    brightnessControl.style.gridTemplateColumns = "1fr 34px";
    brightnessControl.style.gap = "6px";

    const brightnessSlider = document.createElement("input");
    brightnessSlider.type = "range";
    brightnessSlider.min = "0";
    brightnessSlider.max = "255";
    brightnessSlider.step = "1";
    brightnessSlider.value = String(clamp255(state.rgbBrightnessByKey[active.key]));

    const brightnessValue = document.createElement("span");
    brightnessValue.className = "palette-help";
    brightnessValue.textContent = String(clamp255(state.rgbBrightnessByKey[active.key]));

    brightnessSlider.oninput = () => {
      const nextBrightness = clamp255(brightnessSlider.value);
      state.rgbBrightnessByKey[active.key] = nextBrightness;
      brightnessValue.textContent = String(nextBrightness);
      state.paletteFeatureValues[active.key] = applyRgbBrightness(
        state.rgbBaseColorByKey[active.key],
        nextBrightness,
      );
      const [r, g, b] = state.paletteFeatureValues[active.key];
      color.value = `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
    };

    brightnessControl.appendChild(brightnessSlider);
    brightnessControl.appendChild(brightnessValue);
    brightnessWrap.appendChild(brightnessLabel);
    brightnessWrap.appendChild(brightnessControl);
    card.appendChild(brightnessWrap);

    const color = document.createElement("input");
    color.type = "color";
    const [r, g, b] = values;
    color.value = `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
    color.oninput = () => {
      const hex = color.value.replace("#", "");
      state.rgbBaseColorByKey[active.key] = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
      state.paletteFeatureValues[active.key] = applyRgbBrightness(
        state.rgbBaseColorByKey[active.key],
        state.rgbBrightnessByKey[active.key],
      );
    };

    if (state.drawTool === "pencil") {
      const presetsWrap = document.createElement("div");
      presetsWrap.className = "color-presets";

      for (const preset of state.colorPresets) {
        const presetBtn = document.createElement("button");
        presetBtn.type = "button";
        presetBtn.className = "color-preset-btn";

        const swatch = document.createElement("span");
        swatch.className = "color-preset-swatch";
        swatch.style.background = `rgb(${preset.rgb[0]}, ${preset.rgb[1]}, ${preset.rgb[2]})`;

        const label = document.createElement("span");
        label.className = "color-preset-label";
        label.textContent = preset.name;

        presetBtn.appendChild(swatch);
        presetBtn.appendChild(label);
        presetBtn.onclick = () => {
          state.rgbBaseColorByKey[active.key] = [...preset.rgb];
          state.paletteFeatureValues[active.key] = applyRgbBrightness(
            state.rgbBaseColorByKey[active.key],
            state.rgbBrightnessByKey[active.key],
          );
          const [pr, pg, pb] = state.paletteFeatureValues[active.key];
          color.value = `#${[pr, pg, pb].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
        };

        presetsWrap.appendChild(presetBtn);
      }

      card.appendChild(presetsWrap);
    }

    const customWrap = document.createElement("div");
    customWrap.className = "custom-color-row";
    const customLabel = document.createElement("span");
    customLabel.className = "palette-help";
    customLabel.textContent = "Custom";
    customWrap.appendChild(customLabel);
    customWrap.appendChild(color);
    card.appendChild(customWrap);
  } else {
    for (let i = 0; i < active.feature.channels.length; i += 1) {
      const row = document.createElement("label");
      row.className = "feature-input-row";
      const left = document.createElement("span");
      left.textContent = active.feature.kind === "cct"
        ? (i === 0 ? "WW" : "CW")
        : `CH ${active.feature.channels[i]}`;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "255";
      slider.value = String(clamp255(values[i] ?? 0));

      const right = document.createElement("span");
      right.className = "palette-help";
      right.textContent = String(values[i] ?? 0);

      slider.oninput = () => {
        const next = [...(state.paletteFeatureValues[active.key] ?? defaultFeatureValues(active.feature))];
        next[i] = clamp255(slider.value);
        state.paletteFeatureValues[active.key] = next;
        right.textContent = String(next[i]);
      };

      const control = document.createElement("div");
      control.style.display = "grid";
      control.style.gridTemplateColumns = "1fr 34px";
      control.style.gap = "6px";
      control.appendChild(slider);
      control.appendChild(right);

      row.appendChild(left);
      row.appendChild(control);
      card.appendChild(row);
    }
  }

  config.appendChild(card);
}

function activePaletteOption() {
  return featureOptions().find((option) => option.key === state.selectedPaletteKey) || null;
}

function samplePaletteFromCell(fixtureId, stepIndex) {
  const environment = selectedEnvironment();
  const step = getStep(stepIndex);
  if (!environment) return false;

  const envFixture = environment.fixtures.find((fixture) => fixture.id === fixtureId);
  if (!envFixture) return false;
  const fixtureDef = fixtureDefinition(envFixture.fixtureTypeId);
  if (!fixtureDef) return false;

  if (state.paletteLayer === "A") {
    const layerAValues = state.lastFrame?.layerAValues ?? {};
    const fixtureEntries = Object.entries(layerAValues).filter(([key]) => key.startsWith(`${fixtureId}:`));
    if (fixtureEntries.length === 0) return false;

    const active = activePaletteOption();
    let featureId = active?.feature?.id ?? null;
    let values = null;
    if (featureId) {
      const key = `${fixtureId}:${featureId}`;
      if (layerAValues[key]) values = [...layerAValues[key]];
    }
    if (!values) {
      const [entryKey, entryValues] = fixtureEntries[0];
      featureId = entryKey.split(":")[1] ?? null;
      values = [...entryValues];
    }
    if (!featureId || !values) return false;

    const feature = fixtureDef.features.find((item) => item.id === featureId);
    if (!feature) return false;
    const key = `${envFixture.fixtureTypeId}::${feature.id}`;
    state.selectedPaletteKey = key;
    const nextValues = values.slice(0, feature.channels.length);
    while (nextValues.length < feature.channels.length) nextValues.push(0);
    state.paletteFeatureValues[key] = nextValues.map((value) => clamp255(value));
    if (feature.kind === "rgb") {
      state.rgbBaseColorByKey[key] = [...state.paletteFeatureValues[key]];
      state.rgbBrightnessByKey[key] = 255;
    }
    return true;
  }

  if (!step) return false;

  const fixtureFrames = step.frames.filter((item) => item.fixtureId === fixtureId);
  if (fixtureFrames.length === 0) return false;

  const active = activePaletteOption();
  const activeFrame = active
    ? fixtureFrames.find((item) => item.featureId === active.feature.id)
    : null;
  const frame = activeFrame ?? fixtureFrames[0];
  const feature = fixtureDef.features.find((item) => item.id === frame.featureId);
  if (!feature) return false;

  const key = `${envFixture.fixtureTypeId}::${feature.id}`;
  state.selectedPaletteKey = key;
  const values = frameValueToArray(frame.value).slice(0, feature.channels.length);

  while (values.length < feature.channels.length) values.push(0);
  const nextValues = values.map((value) => clamp255(value));
  state.paletteFeatureValues[key] = nextValues;
  if (feature.kind === "rgb") {
    state.rgbBaseColorByKey[key] = [...nextValues];
    state.rgbBrightnessByKey[key] = 255;
  }
  return true;
}

function applyPaletteToCell(fixtureId, stepIndex) {
  const environment = selectedEnvironment();
  const step = state.paletteLayer === "B" ? ensureStepExists(stepIndex) : null;
  if (!environment || (state.paletteLayer === "B" && !step)) {
    return { changed: false, picked: false, fixtureDef: null };
  }

  const envFixture = environment.fixtures.find((fixture) => fixture.id === fixtureId);
  if (!envFixture) return { changed: false, picked: false, fixtureDef: null };
  const fixtureDef = fixtureDefinition(envFixture.fixtureTypeId);
  if (!fixtureDef) return { changed: false, picked: false, fixtureDef: null };

  if (state.drawTool === "picker") {
    return { changed: false, picked: samplePaletteFromCell(fixtureId, stepIndex), fixtureDef };
  }

  if (state.paletteLayer === "A") {
    const active = activePaletteOption();
    const layerAValues = state.lastFrame?.layerAValues ?? {};
    if (state.lastFrame && !state.lastFrame.layerAValues) state.lastFrame.layerAValues = {};

    if (state.drawTool === "eraser") {
      const hadAny = Object.keys(layerAValues).some((key) => key.startsWith(`${fixtureId}:`));
      if (hadAny) {
        if (state.lastFrame?.layerAValues) {
          for (const key of Object.keys(state.lastFrame.layerAValues)) {
            if (!key.startsWith(`${fixtureId}:`)) continue;
            delete state.lastFrame.layerAValues[key];
          }
        }
        send({ type: "layerAClearFixture", payload: { fixtureId } });
      }
      return { changed: hadAny, picked: false, fixtureDef };
    }

    if (!active) return { changed: false, picked: false, fixtureDef };
    const feature = fixtureDef.features.find((item) => item.id === active.feature.id);
    if (!feature) return { changed: false, picked: false, fixtureDef };

    const values = (state.paletteFeatureValues[active.key] ?? defaultFeatureValues(active.feature))
      .slice(0, feature.channels.length);
    while (values.length < feature.channels.length) values.push(values[values.length - 1] ?? 0);
    for (let i = 0; i < values.length; i += 1) values[i] = clamp255(values[i]);

    const key = `${fixtureId}:${feature.id}`;
    const current = layerAValues[key] ?? null;

    if (values.every((value) => value === 0)) {
      if (!current) return { changed: false, picked: false, fixtureDef };
      if (state.lastFrame?.layerAValues) {
        delete state.lastFrame.layerAValues[key];
      }
      send({ type: "layerAClearFeature", payload: { fixtureId, featureId: feature.id } });
      return { changed: true, picked: false, fixtureDef };
    }

    const next = values.slice(0, feature.channels.length);
    const changed = JSON.stringify(current ?? []) !== JSON.stringify(next);
    if (!changed) return { changed: false, picked: false, fixtureDef };
    if (state.lastFrame) {
      state.lastFrame.layerAValues = state.lastFrame.layerAValues ?? {};
      state.lastFrame.layerAValues[key] = [...next];
    }
    send({
      type: "layerASet",
      payload: {
        fixtureId,
        featureId: feature.id,
        value: normalizeByFeature(feature, next),
      },
    });
    return { changed: true, picked: false, fixtureDef };
  }

  if (state.drawTool === "eraser") {
    const before = step.frames.length;
    step.frames = step.frames.filter((frame) => frame.fixtureId !== fixtureId);
    return { changed: step.frames.length !== before, picked: false, fixtureDef };
  }

  const active = activePaletteOption();
  if (!active) {
    return { changed: false, picked: false, fixtureDef };
  }

  const feature = fixtureDef.features.find((item) => item.id === active.feature.id);
  if (!feature) return { changed: false, picked: false, fixtureDef };

  const frameIndex = step.frames.findIndex(
    (frame) => frame.fixtureId === fixtureId && frame.featureId === feature.id,
  );

  const values = (state.paletteFeatureValues[active.key] ?? defaultFeatureValues(active.feature))
    .slice(0, feature.channels.length);
  while (values.length < feature.channels.length) values.push(values[values.length - 1] ?? 0);
  for (let i = 0; i < values.length; i += 1) values[i] = clamp255(values[i]);

  const allZero = values.every((value) => value === 0);
  if (allZero) {
    if (frameIndex >= 0) {
      step.frames.splice(frameIndex, 1);
      return { changed: true, picked: false, fixtureDef };
    }
    return { changed: false, picked: false, fixtureDef };
  }

  const frame = {
    fixtureId,
    featureId: feature.id,
    value: normalizeByFeature(feature, values),
  };

  if (frameIndex >= 0) {
    const before = JSON.stringify(step.frames[frameIndex]);
    const after = JSON.stringify(frame);
    step.frames[frameIndex] = frame;
    return { changed: before !== after, picked: false, fixtureDef };
  }

  step.frames.push(frame);
  return { changed: true, picked: false, fixtureDef };
}

function updateCellPreview(cell, fixtureId, stepIndex, fixtureDef) {
  if (!fixtureDef) {
    cell.style.background = "";
    return;
  }

  if (state.paletteLayer === "A") {
    const source = state.lastFrame?.layerAValues ?? {};
    const values = {};
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith(`${fixtureId}:`)) continue;
      values[key] = Array.isArray(value) ? value : [value];
    }
    cell.style.background = Object.keys(values).length > 0
      ? fixtureColor(values, fixtureId, fixtureDef)
      : "";
    return;
  }

  const step = getStep(stepIndex);
  const frames = step ? getFixtureFramesForStep(step, fixtureId) : [];
  if (frames.length > 0) {
    const values = keyframeValues(step, fixtureId);
    cell.style.background = fixtureColor(values, fixtureId, fixtureDef);
    return;
  }
  cell.style.background = "";
}

function renderStepGrid() {
  stepGrid.innerHTML = "";

  const program = selectedProgram();
  const environment = selectedEnvironment();
  if (!program || !environment) return;

  if (state.paletteLayer === "A") {
    const valueColWidth = CELL_PX * 3;
    stepGrid.style.gridTemplateColumns = `${FIXTURE_LABEL_WIDTH}px ${valueColWidth}px`;

    const topLeft = document.createElement("div");
    topLeft.className = "matrix-cell header fixture-name";
    topLeft.textContent = "";
    stepGrid.appendChild(topLeft);

    const valueHeader = document.createElement("div");
    valueHeader.className = "matrix-cell header static-header";
    valueHeader.textContent = "Static";
    stepGrid.appendChild(valueHeader);

    for (const fixture of environment.fixtures) {
      const fixtureDef = fixtureDefinition(fixture.fixtureTypeId);
      if (!fixtureDef) continue;

      const nameCell = document.createElement("div");
      nameCell.className = "matrix-cell fixture-name";
      nameCell.textContent = fixture.name;
      stepGrid.appendChild(nameCell);

      const cell = document.createElement("div");
      cell.className = "matrix-cell keyframe static-value";
      updateCellPreview(cell, fixture.id, 0, fixtureDef);

      const paintKey = `${fixture.id}:static`;
      const paintCell = () => {
        const { changed, picked, fixtureDef: def } = applyPaletteToCell(
          fixture.id,
          state.currentPlayheadStep,
        );
        if (!changed && !picked) return;
        if (picked) {
          state.drawTool = "pencil";
          renderPalette();
          return;
        }
        updateCellPreview(cell, fixture.id, 0, def);
      };

      cell.onmousedown = (event) => {
        if (event.button !== 0) return;
        state.painting = true;
        state.lastPaintKey = paintKey;
        cell.classList.add("painting");
        paintCell();
      };

      cell.onmouseenter = () => {
        if (!state.painting || state.lastPaintKey === paintKey) return;
        state.lastPaintKey = paintKey;
        cell.classList.add("painting");
        paintCell();
      };

      stepGrid.appendChild(cell);
    }
    return;
  }

  const stepCount = state.timelineSteps;
  stepGrid.style.gridTemplateColumns = `${FIXTURE_LABEL_WIDTH}px repeat(${stepCount + 1}, ${CELL_PX}px)`;

  const topLeft = document.createElement("div");
  topLeft.className = "matrix-cell header fixture-name";
  topLeft.textContent = "";
  stepGrid.appendChild(topLeft);

  for (let i = 0; i < stepCount; i += 1) {
    const header = document.createElement("div");
    header.className = "matrix-cell header step-header";
    header.textContent = String(i + 1);
    if (i === state.currentPlayheadStep) header.classList.add("playhead");
    header.title = stepCount > 1 ? "Click: go to step | Right-click: delete step" : "Click: go to step";
    header.onclick = () => send({ type: "seek", payload: { stepIndex: i } });
    header.oncontextmenu = (event) => {
      event.preventDefault();
      if (stepCount <= 1) return;
      if (!removeStepFromProgram(i)) return;
      markProgramDirty();
      renderStepGrid();
      scheduleAutoSave();
    };
    stepGrid.appendChild(header);
  }

  const addHeader = document.createElement("div");
  addHeader.className = "matrix-cell header step-add";
  addHeader.textContent = "+";
  addHeader.title = "Add step";
  addHeader.onclick = () => {
    if (!addStepToProgram()) return;
    markProgramDirty();
    renderStepGrid();
    scheduleAutoSave();
  };
  stepGrid.appendChild(addHeader);

  for (const fixture of environment.fixtures) {
    const fixtureDef = fixtureDefinition(fixture.fixtureTypeId);
    if (!fixtureDef) continue;

    const nameCell = document.createElement("div");
    nameCell.className = "matrix-cell fixture-name";
    nameCell.textContent = fixture.name;
    stepGrid.appendChild(nameCell);

    for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
      const cell = document.createElement("div");
      cell.className = "matrix-cell keyframe";
      if (stepIndex === state.currentPlayheadStep) cell.classList.add("playhead");

      updateCellPreview(cell, fixture.id, stepIndex, fixtureDef);

      const paintKey = `${fixture.id}:${stepIndex}`;
      const paintCell = () => {
        const { changed, picked, fixtureDef: def } = applyPaletteToCell(fixture.id, stepIndex);
        if (!changed && !picked) return;
        if (picked) {
          state.drawTool = "pencil";
          renderPalette();
          return;
        }

        if (!state.isPlaying) {
          state.currentPlayheadStep = stepIndex;
          send({ type: "seek", payload: { stepIndex } });
        }

        updateCellPreview(cell, fixture.id, stepIndex, def);
        if (stepIndex === state.currentPlayheadStep) {
          scheduleLiveSync();
        }
        markProgramDirty();
        scheduleAutoSave();
      };

      cell.onmousedown = (event) => {
        if (event.button !== 0) return;
        state.painting = true;
        state.lastPaintKey = paintKey;
        cell.classList.add("painting");
        paintCell();
      };

      cell.onmouseenter = () => {
        if (!state.painting || state.lastPaintKey === paintKey) return;
        state.lastPaintKey = paintKey;
        cell.classList.add("painting");
        paintCell();
      };

      stepGrid.appendChild(cell);
    }

    const pad = document.createElement("div");
    pad.className = "matrix-cell";
    stepGrid.appendChild(pad);
  }
}

function updateSimulator(frame) {
  if (!frame?.state) return;

  const frameState = frame.state;
  const previousRunningProgramId = state.runningProgramId;
  state.lastFrame = frame;
  state.runningProgramId = frameState.programId ?? state.runningProgramId;
  state.isBlackout = Boolean(frameState.isBlackout);
  updateBlackoutUi();

  if (
    state.runningProgramId
    && state.runningProgramId !== state.selectedProgramId
    && state.programs.some((program) => program.id === state.runningProgramId)
    && previousRunningProgramId !== state.runningProgramId
  ) {
    fillProgramSelect();
    renderPalette();
    renderStepGrid();
  }

  const baseSpm = clampSpm(frameState.spm / currentSpmMultiplier());
  const targetSpm = effectiveSpmFromBase(baseSpm);
  spmInput.value = String(baseSpm);
  if (frameState.spm !== targetSpm) {
    send({ type: "tempo", payload: { spm: targetSpm } });
  }
  setLoopEnabled(Boolean(frameState.loop));

  drawSimulator(frame);

  if (state.currentPlayheadStep !== frameState.stepIndex) {
    state.currentPlayheadStep = frameState.stepIndex;
    renderStepGrid();
  }

  if (state.isPlaying !== frameState.isPlaying) {
    state.isPlaying = frameState.isPlaying;
    updatePlayPauseLabel();
  }
}

async function saveProgramNow() {
  const program = selectedProgram();
  if (!program) return;
  const targetVersion = state.editVersion;

  const response = await fetch(`./api/programs/${program.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(program),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Failed to save program");
  }

  const updated = await response.json();
  state.lastSavedVersion = Math.max(state.lastSavedVersion, targetVersion);
}

async function queueAutoSave() {
  if (state.editVersion === state.lastSavedVersion) return;
  if (state.saveInFlight) {
    state.savePending = true;
    return;
  }

  state.saveInFlight = true;
  try {
    await saveProgramNow();
  } catch (_error) {
    // Do not block editing on save errors.
  } finally {
    state.saveInFlight = false;
    if (state.savePending || state.editVersion !== state.lastSavedVersion) {
      state.savePending = false;
      scheduleAutoSave();
    }
  }
}

function scheduleAutoSave() {
  if (state.saveTimerId) {
    clearTimeout(state.saveTimerId);
  }
  state.saveTimerId = setTimeout(() => {
    state.saveTimerId = null;
    queueAutoSave();
  }, 1000);
}

function scheduleLiveSync() {
  if (state.liveSyncTimerId) return;
  state.liveSyncTimerId = setTimeout(() => {
    state.liveSyncTimerId = null;
    queueAutoSave();
  }, 120);
}

async function createProgram() {
  const baseProgram = selectedProgram();
  if (!baseProgram) return;
  const promptName = window.prompt("Program name", "New Program");
  if (promptName === null) return;
  const name = normalizeName(promptName) || "New Program";
  const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "program";
  const program = {
    id: `${idBase}-${Date.now()}`,
    name,
    environmentId: baseProgram.environmentId,
    spm: baseProgram.spm ?? 120,
    loop: typeof baseProgram.loop === "boolean" ? baseProgram.loop : true,
    steps: Array.from({ length: Math.max(1, state.timelineSteps) }, (_, index) => ({
      id: `step-${index + 1}`,
      durationMs: 500,
      fadeMs: clampFadeMs(fadeMsInput.value),
      frames: [],
    })),
  };

  const response = await fetch("./api/programs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(program),
  });
  if (!response.ok) {
    const data = await response.json();
    alert(data.error || "Failed to create program");
    return;
  }

  const created = await response.json();
  state.programs.push(created);
  state.selectedProgramId = created.id;
  state.timelineSteps = Math.max(1, created.steps.length || 1);
  state.currentPlayheadStep = 0;

  fillProgramSelect();
  renderPalette();
  renderStepGrid();
  activateSelectedProgram(created.id);
}

async function deleteProgram() {
  const program = selectedProgram();
  if (!program) return;
  if (state.programs.length <= 1) {
    alert("Cannot delete the last program.");
    return;
  }
  const confirmed = window.confirm(`Delete program "${program.name}"?`);
  if (!confirmed) return;

  const response = await fetch(`./api/programs/${program.id}`, { method: "DELETE" });
  if (!response.ok) {
    alert("Failed to delete program");
    return;
  }

  const fallback = state.programs.find((item) => item.id !== program.id);
  if (fallback) {
    state.selectedProgramId = fallback.id;
    fillProgramSelect();
    renderPalette();
    renderStepGrid();
    activateSelectedProgram(fallback.id);
  }
}

function applyPrograms(programs) {
  state.programs = programs;
  fillProgramSelect();
  renderMobileProgramGrid();
  renderStepGrid();
  if (state.lastFrame) drawSimulator(state.lastFrame);
}

function applyConfig(config) {
  state.config = config;
  renderLayerModeSwitch();
  renderPalette();
  renderStepGrid();
  if (state.lastFrame) {
    drawSimulator(state.lastFrame);
  } else if (selectedProgram()) {
    drawSimulator({ values: {}, state: { stepIndex: 0 } });
  }
}

function endPaint() {
  if (!state.painting) return;
  state.painting = false;
  state.lastPaintKey = null;
  for (const cell of stepGrid.querySelectorAll(".matrix-cell.keyframe.painting")) {
    cell.classList.remove("painting");
  }
  renderStepGrid();
}

document.addEventListener("mouseup", endPaint);
document.addEventListener("mouseleave", endPaint);

playPauseBtn.onclick = () => {
  if (state.isPlaying) send({ type: "pause" });
  else send({ type: "play" });
};

prevBtn.onclick = () => send({ type: "previous" });
nextBtn.onclick = () => send({ type: "next" });
seekStartBtn.onclick = () => send({ type: "seek", payload: { stepIndex: 0 } });
seekEndBtn.onclick = () => send({ type: "seek", payload: { stepIndex: Math.max(0, state.timelineSteps - 1) } });

blackoutBtn.onclick = () => {
  state.isBlackout = !state.isBlackout;
  send({ type: "blackout", payload: { enabled: state.isBlackout } });
  updateBlackoutUi();
};

spmInput.oninput = () => {
  applyBaseSpmChange(spmInput.value);
};

spmMultiplierSelect.onchange = () => {
  const baseSpm = clampSpm(spmInput.value);
  send({ type: "tempo", payload: { spm: effectiveSpmFromBase(baseSpm) } });
};

fadeMsInput.onchange = () => {
  const program = selectedProgram();
  if (!program) return;
  const fadeMs = clampFadeMs(fadeMsInput.value);
  fadeMsInput.value = String(fadeMs);
  let changed = false;
  for (const step of program.steps) {
    if (step.fadeMs !== fadeMs) {
      step.fadeMs = fadeMs;
      changed = true;
    }
  }
  if (changed) {
    markProgramDirty();
    scheduleAutoSave();
  }
};

loopInput.onclick = () => {
  const enabled = !isLoopEnabled();
  setLoopEnabled(enabled);
  const program = selectedProgram();
  if (program) {
    program.loop = enabled;
    markProgramDirty();
    scheduleAutoSave();
  }
  send({ type: "loop", payload: { enabled } });
};

tapSyncBtn.onclick = () => {
  handleTapSync();
};

spmDownBtn.onclick = () => {
  applyBaseSpmChange(Number(spmInput.value) - 1);
};

spmUpBtn.onclick = () => {
  applyBaseSpmChange(Number(spmInput.value) + 1);
};

programSelect.onchange = () => {
  selectProgram(programSelect.value);
};

createProgramBtn.onclick = () => createProgram();
deleteProgramBtn.onclick = () => deleteProgram();
mobileTabPlaybackBtn.onclick = () => setMobileTab("playback");
mobileTabSequencerBtn.onclick = () => setMobileTab("sequencer");

window.addEventListener("resize", () => {
  applyMobileTabUi();
  if (state.lastFrame) drawSimulator(state.lastFrame);
});

const simulatorResizeObserver = new ResizeObserver(() => {
  if (state.lastFrame) drawSimulator(state.lastFrame);
});
simulatorResizeObserver.observe(simulator);

ws.onmessage = (message) => {
  const event = JSON.parse(message.data);

  if (event.type === "config") applyConfig(event.payload);
  if (event.type === "programs") applyPrograms(event.payload);
  if (event.type === "frame") updateSimulator(event.payload);
};

updatePlayPauseLabel();
updateBlackoutUi();
setLoopEnabled(true);
updateTapSyncUi();
applyMobileTabUi();
renderLayerModeSwitch();
loadColorPresets().then(() => renderPalette());
