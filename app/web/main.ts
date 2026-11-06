import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './style.css';
import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  LocalTrackPublication,
  type Participant,
  RemoteAudioTrack,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
} from 'livekit-client';

type Preset = { id: string; label: string; detail: string; width: number; height: number; fps: number; bitrate: number };

const PRESETS: Preset[] = [
  { id: '1080p60', label: '1080p 60', detail: 'Melhor para jogos', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
  { id: '720p60', label: '720p 60', detail: 'Conexão lenta', width: 1280, height: 720, fps: 60, bitrate: 4_500_000 },
  { id: '1080p30', label: '1080p 30', detail: 'Mais nitidez, menos fluidez', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
];

// Viewers on a poor connection drop to this layer without affecting anyone else.
const LOW_LAYER = new VideoPreset(960, 540, 1_200_000, 30);

const CHROME_HIDE_MS = 2500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  gate: $('gate'),
  gateForm: $<HTMLFormElement>('gate-form'),
  gateStatus: $('gate-status'),
  gateError: $('gate-error'),
  passwordField: $('password-field'),
  password: $<HTMLInputElement>('password'),
  name: $<HTMLInputElement>('name'),
  join: $<HTMLButtonElement>('join'),
  room: $('room'),
  stage: $('stage'),
  video: $<HTMLVideoElement>('video'),
  idle: $('idle'),
  shareForm: $<HTMLFormElement>('share-form'),
  shareUnsupported: $('share-unsupported'),
  presets: $('presets'),
  liveSelf: $('live-self'),
  liveSelfDetail: $('live-self-detail'),
  liveSelfAudio: $('live-self-audio'),
  stopShare: $<HTMLButtonElement>('stop-share'),
  stageBar: $('stage-bar'),
  stageTitle: $('stage-title'),
  streamVolume: $<HTMLInputElement>('stream-volume'),
  fullscreen: $<HTMLButtonElement>('fullscreen'),
  count: $('count'),
  banner: $('banner'),
  enableAudio: $<HTMLButtonElement>('enable-audio'),
  people: $<HTMLUListElement>('people'),
  micSelect: $<HTMLSelectElement>('mic-select'),
  mute: $<HTMLButtonElement>('mute'),
  muteLabel: $('mute-label'),
  deafen: $<HTMLButtonElement>('deafen'),
  deafenLabel: $('deafen-label'),
  leave: $<HTMLButtonElement>('leave'),
  audioSink: $('audio-sink'),
};

// Storage can throw in private windows. Everything stored here is a convenience.
const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not worth surfacing */
    }
  },
};

const room = new Room({
  adaptiveStream: true,
  dynacast: true,
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  publishDefaults: { dtx: true, red: true },
});

let authenticated = false;
let micAvailable = false;
let deafened = false;
let mutedBeforeDeafen = false;
let sharing = false;
let shareBusy = false;
let streamVolume = Number(store.get('streamVolume') ?? 0.8);
let attachedVideo: Track | undefined;
let chromeTimer: number | undefined;
let bannerTimer: number | undefined;

const isSharing = (p: Participant) => !!p.getTrackPublication(Track.Source.ScreenShare);
const everyone = (): Participant[] => [room.localParticipant, ...room.remoteParticipants.values()];

/**
 * Only one person can be live. Everyone resolves a simultaneous start the same
 * way, by lowest identity, so all clients agree without a server round trip.
 */
function currentStreamer(): Participant | undefined {
  return everyone()
    .filter(isSharing)
    .sort((a, b) => a.identity.localeCompare(b.identity))[0];
}

async function api<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

function showGateError(message: string) {
  el.gateError.textContent = message;
  el.gateError.hidden = !message;
}

function showPasswordField(show: boolean) {
  el.passwordField.hidden = !show;
  el.password.required = show;
}

async function initGate() {
  el.name.value = store.get('name') ?? '';

  if (!window.isSecureContext) {
    el.gateStatus.textContent = 'Abra esta página por https, senão o navegador bloqueia o microfone e o compartilhamento de tela.';
    el.join.disabled = true;
    return;
  }

  try {
    const { data } = await api<{ authenticated: boolean }>('/api/session');
    authenticated = data.authenticated;
  } catch {
    el.gateStatus.textContent = 'Não foi possível acessar o servidor.';
    return;
  }
  el.gateStatus.textContent = authenticated ? 'Você ainda tem a chave.' : 'Só para amigos.';
  showPasswordField(!authenticated);
  (authenticated ? el.name : el.password).focus();
}

async function join(event: SubmitEvent) {
  event.preventDefault();
  showGateError('');
  el.join.disabled = true;

  try {
    if (!authenticated) {
      const { status, data } = await api<{ error?: string }>('/api/login', { password: el.password.value });
      if (status !== 200) return showGateError(data.error ?? 'Não foi possível entrar.');
      authenticated = true;
      el.password.value = '';
      showPasswordField(false);
    }

    const name = el.name.value.trim();
    const { status, data } = await api<{ token?: string; error?: string }>('/api/token', { name });
    if (status === 401) {
      authenticated = false;
      showPasswordField(true);
      return showGateError('Sua sessão expirou. Digite a senha de novo.');
    }
    if (!data.token) return showGateError(data.error ?? 'Não foi possível entrar na sala.');
    store.set('name', name);

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    await room.connect(`${scheme}://${location.host}`, data.token);
    // Still inside the click on the join button, which is what unlocks audio.
    await room.startAudio();
    enterRoom();
    await enableMic();
  } catch (error) {
    console.error(error);
    showGateError('Não foi possível conectar à sala. Tente de novo em instantes.');
  } finally {
    el.join.disabled = false;
  }
}

function enterRoom() {
  el.gate.hidden = true;
  el.room.hidden = false;
  render();
}

async function enableMic() {
  try {
    await room.localParticipant.setMicrophoneEnabled(true, { deviceId: store.get('micId') ?? undefined });
    micAvailable = true;
    await refreshMics();
  } catch (error) {
    console.warn('microphone unavailable', error);
    micAvailable = false;
  }
  render();
}

async function refreshMics() {
  const devices = await Room.getLocalDevices('audioinput', false);
  const active = room.getActiveDevice('audioinput');
  el.micSelect.replaceChildren(
    ...devices.map((device, index) => new Option(device.label || `Microfone ${index + 1}`, device.deviceId, false, device.deviceId === active)),
  );
}

function renderPresets() {
  const chosen = store.get('preset') ?? PRESETS[0].id;
  for (const preset of PRESETS) {
    const label = document.createElement('label');
    label.className = 'preset';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'preset';
    input.value = preset.id;
    input.checked = preset.id === chosen;
    const title = document.createElement('b');
    title.textContent = preset.label;
    const detail = document.createElement('span');
    detail.textContent = preset.detail;
    label.append(input, title, detail);
    el.presets.append(label);
  }
}

async function startShare(preset: Preset) {
  if (shareBusy || currentStreamer()) return;
  shareBusy = true;
  let stream: MediaStream | undefined;

  try {
    const audio: MediaTrackConstraints & { restrictOwnAudio?: boolean } = {
      // These are tuned for voices and wreck game audio.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    // System audio includes this tab, so without this, viewers hear themselves.
    const supported = navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean };
    if (supported.restrictOwnAudio) audio.restrictOwnAudio = true;

    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: preset.width }, height: { max: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } },
      audio,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);

    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();

    // Someone may have gone live while the browser's picker was open.
    if (currentStreamer()) {
      stream.getTracks().forEach((track) => track.stop());
      showBanner(`${currentStreamer()?.name} começou a transmitir primeiro.`);
      return;
    }

    videoTrack.contentHint = 'motion';
    videoTrack.addEventListener('ended', () => void stopShare());

    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: 'h264',
      simulcast: true,
      screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps },
      screenShareSimulcastLayers: [LOW_LAYER],
      degradationPreference: 'maintain-framerate',
    });

    if (audioTrack) {
      audioTrack.contentHint = 'music';
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.musicHighQualityStereo,
        forceStereo: true,
        dtx: false,
        red: false,
      });
    }

    sharing = true;
    el.liveSelfDetail.textContent = `${preset.label} a até ${String(preset.bitrate / 1_000_000).replace('.', ',')} Mbps.`;
    el.liveSelfAudio.textContent = 'Nenhum som está sendo transmitido. Pare, escolha Tela inteira e ative o áudio do sistema.';
    el.liveSelfAudio.hidden = !!audioTrack;
    // A rival's share can land while the two publishes above are in flight.
    resolveShareConflict();
  } catch (error) {
    // NotAllowedError is just someone closing the picker.
    if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
      console.error(error);
      showBanner('Não foi possível começar a transmitir.');
    }
    stream?.getTracks().forEach((track) => track.stop());
    await stopShare();
  } finally {
    shareBusy = false;
    render();
  }
}

async function stopShare() {
  sharing = false;
  const local = room.localParticipant;
  const publications = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
    .map((source) => local.getTrackPublication(source))
    .filter((publication): publication is LocalTrackPublication => !!publication);
  await Promise.all(publications.map((publication) => publication.track && local.unpublishTrack(publication.track, true)));
  render();
}

/** Backs out of a simultaneous start that this client lost. */
function resolveShareConflict() {
  const streamer = currentStreamer();
  if (sharing && streamer && streamer !== room.localParticipant) {
    showBanner(`${streamer.name} começou a transmitir primeiro.`);
    void stopShare();
  }
}

function showBanner(message: string, sticky = false) {
  el.banner.textContent = message;
  el.banner.hidden = false;
  window.clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = window.setTimeout(() => (el.banner.hidden = true), 5000);
}

function syncStage() {
  const streamer = currentStreamer();
  const isLocal = streamer === room.localParticipant;
  const track = !isLocal ? streamer?.getTrackPublication(Track.Source.ScreenShare)?.track : undefined;

  if (track !== attachedVideo) {
    attachedVideo?.detach(el.video);
    track?.attach(el.video);
    attachedVideo = track;
  }

  el.video.hidden = !streamer || isLocal;
  el.stageBar.hidden = !streamer || isLocal;
  el.idle.hidden = !!streamer;
  el.liveSelf.hidden = !isLocal;
  el.stage.classList.toggle('stage-live', !!streamer && !isLocal);
  if (streamer) el.stageTitle.textContent = `Tela de ${streamer.name}`;
  if (!streamer && document.fullscreenElement) void document.exitFullscreen();
}

function renderPeople() {
  const streamer = currentStreamer();
  const rows = everyone().map((participant) => {
    const row = document.createElement('li');
    row.className = 'person';
    row.classList.toggle('person-speaking', participant.isSpeaking);

    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = participant.name || 'Alguém';
    row.append(name);

    if (participant === room.localParticipant) {
      const you = document.createElement('span');
      you.className = 'person-you';
      you.textContent = 'você';
      row.append(you);
    }

    const status = document.createElement('span');
    status.className = 'person-status';
    const hasMic = participant.getTrackPublication(Track.Source.Microphone);
    status.textContent = participant === streamer ? 'ao vivo' : !hasMic || !participant.isMicrophoneEnabled ? 'mutado' : '';
    status.classList.toggle('person-status-live', participant === streamer);
    row.append(status);
    return row;
  });
  el.people.replaceChildren(...rows);
  el.count.textContent = String(rows.length);
}

function renderControls() {
  const muted = !room.localParticipant.isMicrophoneEnabled;
  el.mute.disabled = !micAvailable || deafened;
  el.mute.setAttribute('aria-pressed', String(muted));
  el.muteLabel.textContent = !micAvailable ? 'Sem mic' : muted ? 'Desmutar' : 'Mutar';
  el.deafen.setAttribute('aria-pressed', String(deafened));
  el.deafenLabel.textContent = deafened ? 'Ligar som' : 'Desligar som';
  el.micSelect.disabled = !micAvailable;
  el.enableAudio.hidden = room.canPlaybackAudio;
}

function render() {
  if (el.room.hidden) return;
  syncStage();
  renderPeople();
  renderControls();
}

function applyAudioOutput() {
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      const track = publication.track;
      if (!(track instanceof RemoteAudioTrack)) continue;
      const isStream = publication.source === Track.Source.ScreenShareAudio;
      track.setVolume(deafened ? 0 : isStream ? streamVolume : 1);
    }
  }
}

async function toggleMute() {
  if (!micAvailable || deafened) return;
  await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
  render();
}

async function toggleDeafen() {
  deafened = !deafened;
  applyAudioOutput();
  if (micAvailable) {
    if (deafened) mutedBeforeDeafen = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!deafened && !mutedBeforeDeafen);
  }
  render();
}

function toggleFullscreen() {
  if (el.stageBar.hidden) return;
  if (document.fullscreenElement) return void document.exitFullscreen();
  if (el.stage.requestFullscreen) return void el.stage.requestFullscreen();
  // iPhones only allow the video element itself to go fullscreen.
  (el.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
}

function wakeStageChrome() {
  el.stage.classList.remove('stage-idle');
  window.clearTimeout(chromeTimer);
  chromeTimer = window.setTimeout(() => el.stage.classList.add('stage-idle'), CHROME_HIDE_MS);
}

function onTrackSubscribed(track: RemoteTrack) {
  if (track.kind === Track.Kind.Audio) {
    el.audioSink.append(track.attach());
    applyAudioOutput();
  }
  render();
}

function onTrackUnsubscribed(track: RemoteTrack) {
  if (track.kind === Track.Kind.Audio) track.detach().forEach((element) => element.remove());
  render();
}

function onDisconnected(reason?: DisconnectReason) {
  sharing = false;
  deafened = false;
  micAvailable = false;
  attachedVideo?.detach(el.video);
  attachedVideo = undefined;
  el.audioSink.replaceChildren();
  el.banner.hidden = true;
  el.room.hidden = true;
  el.gate.hidden = false;
  el.gateStatus.textContent = reason === DisconnectReason.CLIENT_INITIATED ? 'Você saiu da sala.' : 'A conexão com a sala caiu.';
}

room
  .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
  .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
  .on(RoomEvent.TrackPublished, () => {
    resolveShareConflict();
    render();
  })
  .on(RoomEvent.TrackUnpublished, render)
  .on(RoomEvent.LocalTrackPublished, render)
  .on(RoomEvent.LocalTrackUnpublished, render)
  .on(RoomEvent.TrackMuted, render)
  .on(RoomEvent.TrackUnmuted, render)
  .on(RoomEvent.ParticipantConnected, render)
  .on(RoomEvent.ParticipantDisconnected, render)
  .on(RoomEvent.ActiveSpeakersChanged, render)
  .on(RoomEvent.AudioPlaybackStatusChanged, render)
  .on(RoomEvent.MediaDevicesChanged, () => {
    if (micAvailable) void refreshMics();
  })
  .on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state === ConnectionState.Reconnecting) showBanner('Conexão perdida. Reconectando…', true);
    if (state === ConnectionState.Connected) el.banner.hidden = true;
  })
  .on(RoomEvent.Disconnected, onDisconnected);

el.gateForm.addEventListener('submit', join);
el.shareForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = new FormData(el.shareForm).get('preset');
  const preset = PRESETS.find((candidate) => candidate.id === id) ?? PRESETS[0];
  store.set('preset', preset.id);
  void startShare(preset);
});
el.stopShare.addEventListener('click', () => void stopShare());
el.mute.addEventListener('click', () => void toggleMute());
el.deafen.addEventListener('click', () => void toggleDeafen());
el.leave.addEventListener('click', async () => {
  await stopShare();
  await room.disconnect();
});
el.enableAudio.addEventListener('click', () => void room.startAudio());
el.fullscreen.addEventListener('click', toggleFullscreen);
el.video.addEventListener('dblclick', toggleFullscreen);
el.stage.addEventListener('pointermove', wakeStageChrome);
el.micSelect.addEventListener('change', async () => {
  store.set('micId', el.micSelect.value);
  await room.switchActiveDevice('audioinput', el.micSelect.value);
});
el.streamVolume.value = String(streamVolume);
el.streamVolume.addEventListener('input', () => {
  streamVolume = Number(el.streamVolume.value);
  store.set('streamVolume', el.streamVolume.value);
  applyAudioOutput();
});

document.addEventListener('keydown', (event) => {
  if (el.room.hidden || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  if (event.target instanceof HTMLSelectElement) return;
  const actions: Record<string, () => void> = {
    m: () => void toggleMute(),
    d: () => void toggleDeafen(),
    f: toggleFullscreen,
  };
  actions[event.key.toLowerCase()]?.();
});

const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
el.shareForm.hidden = !canShare;
el.shareUnsupported.hidden = canShare;
renderPresets();
void initGate();
