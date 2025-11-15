// ✅ FULL UPDATED FILE — Group code gate + realtime Firestore sync
const { useState, useRef, useEffect } = React;

const APP_VERSION = "2025.11.18";
const VERSION_KEY = "app_version";
const RELOAD_FLAG = "app_version_reloading";

const patternGlobals = window.MetronomePattern || {};
const SAMPLES_BASE = "sound/Real Drum Kit";
const PATTERN_INSTRUMENTS = patternGlobals.PATTERN_INSTRUMENTS || [
  {
    id: "bd",
    label: "BD",
    color: "#fb923c",
    freq: 120,
    sample: `${SAMPLES_BASE}/BD.wav`,
  },
  {
    id: "sd",
    label: "SD",
    color: "#facc15",
    freq: 220,
    sample: `${SAMPLES_BASE}/SD.wav`,
  },
  {
    id: "hh",
    label: "HH",
    color: "#60a5fa",
    freq: 450,
    sample: `${SAMPLES_BASE}/HH.wav`,
  },
];
const PATTERN_STEPS = patternGlobals.PATTERN_STEPS || 16;
const externalCreatePattern = patternGlobals.createEmptyPattern;
const createPatternBase =
  typeof externalCreatePattern === "function"
    ? externalCreatePattern
    : () => ({
        steps: PATTERN_STEPS,
        tracks: PATTERN_INSTRUMENTS.map(inst => ({
          id: inst.id,
          name: inst.label,
          color: inst.color,
          sample: inst.sample,
          steps: Array(PATTERN_STEPS).fill(false),
        })),
      });
const instrumentMetaById = PATTERN_INSTRUMENTS.reduce((acc, inst) => {
  acc[inst.id] = inst;
  return acc;
}, {});

const normalizePattern = (pattern) => {
  const steps = pattern?.steps && pattern.steps > 0 ? pattern.steps : PATTERN_STEPS;
  const tracks = pattern?.tracks || [];
  return {
    steps,
    tracks: PATTERN_INSTRUMENTS.map(inst => {
      const existing =
        tracks.find(t => t.id === inst.id) ||
        tracks.find(t => t.name === inst.label);
      const existingSteps = Array.isArray(existing?.steps) ? existing.steps : [];
      return {
        id: inst.id,
        name: inst.label,
        color: inst.color,
        sample: inst.sample,
        steps: Array.from({ length: steps }, (_, idx) => Boolean(existingSteps[idx])),
      };
    }),
  };
};

const normalizeSong = (song) => ({
  ...song,
  pattern: normalizePattern(song?.pattern),
});

const ensureSongsStructure = (songs = []) => songs.map(normalizeSong);

const createEmptyPatternForSong = () => normalizePattern(createPatternBase());

const patternHasActiveSteps = (pattern) =>
  !!pattern?.tracks?.some(track => track.steps.some(Boolean));

const instrumentFrequencyMap = PATTERN_INSTRUMENTS.reduce((acc, inst) => {
  acc[inst.id] = inst.freq || 220;
  return acc;
}, {});

function App() {
  // ====== GROUP CODE GATE ======
  const [bandCodeInput, setBandCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [bandCode, setBandCode] = useState(() => localStorage.getItem("band_code") || "");

  const CORRECT_CODE = "0000"; // <- общий код группы

  const handleSubmitCode = () => {
    if (bandCodeInput.trim() === CORRECT_CODE) {
      localStorage.setItem("band_code", CORRECT_CODE);
      setBandCode(CORRECT_CODE);
      setCodeError("");
    } else {
      setCodeError("Неверный код. Попробуйте ещё раз.");
    }
  };

  const resetCode = () => {
    localStorage.removeItem("band_code");
    setBandCode("");
    setBandCodeInput("");
    setCodeError("");
  };

  // ====== SONGS STATE ======
  const [songs, setSongs] = useState(() => {
    const saved = localStorage.getItem("songs_final2");
    return saved ? ensureSongsStructure(JSON.parse(saved)) : [];
  });

  const [currentSong, setCurrentSong] = useState(null);
  const [newSongName, setNewSongName] = useState("");

  const sectionTypes = ["INTRO", "VERSE", "PRECHORUS", "CHORUS", "POSTCHORUS","BRIDGE", "SOLO", "OUTRO", "PAUSE"];
  const [newSection, setNewSection] = useState({ name: "VERSE", bars: 4, comment: "" });

  const [showAddForm, setShowAddForm] = useState(false);

  const [bpm, setBpm] = useState(120);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(1);
  const [currentBar, setCurrentBar] = useState(0);
  const [currentPatternStep, setCurrentPatternStep] = useState(0);
  const [showPatternEditor, setShowPatternEditor] = useState(false);
  const [patternEditorReady, setPatternEditorReady] = useState(() => Boolean(window.PatternEditor));

  const beatsPerBar = 4;
  const MIN_BPM = 40;
  const MAX_BPM = 240;
  const audioContextRef = useRef(null);
  const timerRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(1);
  const barRef = useRef(0);
  const currentSectionRef = useRef(null);
  const visualQueueRef = useRef([]);
  const visualRafRef = useRef(null);
  const sampleDataRef = useRef({});
  const sampleBufferRef = useRef({});
  const sampleFetchPromisesRef = useRef({});
  const sampleDecodePromisesRef = useRef({});

  const totalBars = song => song ? song.sections.reduce((s, sec) => s + sec.bars, 0) : 0;

  const fetchSampleData = (instrumentId) => {
    if (sampleDataRef.current[instrumentId]) {
      return Promise.resolve(sampleDataRef.current[instrumentId]);
    }
    if (sampleFetchPromisesRef.current[instrumentId]) {
      return sampleFetchPromisesRef.current[instrumentId];
    }
    const samplePath = instrumentMetaById[instrumentId]?.sample;
    if (!samplePath) return Promise.resolve(null);
    const promise = fetch(samplePath)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(data => {
        sampleDataRef.current[instrumentId] = data;
        return data;
      })
      .catch(err => {
        console.warn(`Failed to fetch sample "${instrumentId}":`, err);
        return null;
      })
      .finally(() => {
        delete sampleFetchPromisesRef.current[instrumentId];
      });
    sampleFetchPromisesRef.current[instrumentId] = promise;
    return promise;
  };

  const ensureSampleBuffer = async (instrumentId) => {
    if (sampleBufferRef.current[instrumentId]) {
      return sampleBufferRef.current[instrumentId];
    }
    if (sampleDecodePromisesRef.current[instrumentId]) {
      return sampleDecodePromisesRef.current[instrumentId];
    }
    if (!audioContextRef.current) return null;

    const data =
      sampleDataRef.current[instrumentId] ||
      (await fetchSampleData(instrumentId));
    if (!data) return null;

    const decodePromise = audioContextRef.current
      .decodeAudioData(data.slice(0))
      .then(buffer => {
        sampleBufferRef.current[instrumentId] = buffer;
        return buffer;
      })
      .catch(err => {
        console.warn(`Failed to decode sample "${instrumentId}":`, err);
        return null;
      })
      .finally(() => {
        delete sampleDecodePromisesRef.current[instrumentId];
      });

    sampleDecodePromisesRef.current[instrumentId] = decodePromise;
    return decodePromise;
  };

  useEffect(() => {
    PATTERN_INSTRUMENTS.forEach(inst => {
      if (inst.sample) {
        fetchSampleData(inst.id);
      }
    });
  }, []);

  useEffect(() => {
    if (patternEditorReady) return;
    const readyHandler = () => setPatternEditorReady(true);
    document.addEventListener("pattern-editor-ready", readyHandler);
    if (window.PatternEditor) {
      setPatternEditorReady(true);
    }
    return () => {
      document.removeEventListener("pattern-editor-ready", readyHandler);
    };
  }, [patternEditorReady]);

  // ====== FIRESTORE REALTIME SYNC ======
  // Слушатель облака (включается только при верном коде)
  useEffect(() => {
    const storedVersion = localStorage.getItem(VERSION_KEY);
    if (storedVersion === APP_VERSION) {
      sessionStorage.removeItem(RELOAD_FLAG);
      return;
    }

    localStorage.setItem(VERSION_KEY, APP_VERSION);

    const cleanupCaches = async () => {
      try {
        if (window.caches) {
          const cachesKeys = await caches.keys();
          await Promise.all(
            cachesKeys
              .filter(name => name.startsWith("metrognom-cache"))
              .map(name => caches.delete(name))
          );
        }
        if (navigator.serviceWorker?.getRegistrations) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(reg => reg.unregister()));
        }
      } catch (err) {
        console.warn("Version cleanup error:", err);
      } finally {
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, "1");
          window.location.reload();
        } else {
          sessionStorage.removeItem(RELOAD_FLAG);
        }
      }
    };

    cleanupCaches();
  }, []);

  useEffect(() => {
    if (bandCode !== CORRECT_CODE) return;
    const docRef = db.collection("bands").doc(bandCode);

    const unsub = docRef.onSnapshot((doc) => {
      const data = doc.data();
      if (data && Array.isArray(data.songs)) {
        const normalized = ensureSongsStructure(data.songs);
        setSongs(normalized);
        localStorage.setItem("songs_final2", JSON.stringify(normalized));
        setCurrentSong(prev => {
          if (!prev) return prev;
          return normalized.find(s => s.id === prev.id) || null;
        });
      } else {
        // если документа ещё нет — создадим пустой
        docRef.set({ songs: [], updatedAt: serverTimestamp() }).catch(() => {});
      }
    }, (err) => {
      console.warn("Firestore listener error:", err);
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandCode]);

  // Сохранение в облако + локально
  const save = async (updatedSongs, updated = currentSong) => {
    const normalized = ensureSongsStructure(updatedSongs);
    setSongs(normalized);
    localStorage.setItem("songs_final2", JSON.stringify(normalized));

    if (bandCode === CORRECT_CODE) {
      try {
        await db.collection("bands").doc(bandCode).set({
          songs: normalized,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        console.warn("Cloud save failed:", e);
      }
    }

    if (updated) {
      setCurrentSong(normalized.find(s => s.id === updated.id));
    }
  };

  const createSong = () => {
    if (!newSongName.trim()) return;
    const song = {
      id: Date.now(),
      name: newSongName.trim(),
      sections: [
        { name: "1 2 3 4", bars: 2, intro: true }
      ],
      pattern: createEmptyPatternForSong(),
    };
    save([...songs, song]);
    setNewSongName("");
  };

  const selectSong = (song) => {
    stop();
    setCurrentSong(song);
    setCurrentBeat(1);
    setCurrentBar(0);
    setCurrentPatternStep(0);
    setShowPatternEditor(false);
  };

  const deleteSong = (id) => {
    const updated = songs.filter(s => s.id !== id);
    save(updated, currentSong?.id === id ? null : currentSong);
  };

  const addSection = () => {
    if (!currentSong) return;

    const updated = songs.map(s =>
      s.id === currentSong.id
        ? { 
            ...s, 
            sections: [...s.sections, 
              { ...newSection, bars: Math.max(1, newSection.bars), intro: false }
            ] 
          }
        : s
    );
    save(updated);
    setShowAddForm(false);
    setNewSection({ name: "VERSE", bars: 4, comment: "" });
  };

  const removeSection = (i) => {
    if (currentSong.sections[i].intro) return;
    const updated = songs.map(s =>
      s.id === currentSong.id
        ? { ...s, sections: s.sections.filter((_, idx) => idx !== i) }
        : s
    );
    save(updated);
  };

  const togglePatternStep = (trackId, stepIdx) => {
    if (!currentSong) return;
    const updated = songs.map(s => {
      if (s.id !== currentSong.id) return s;
      const updatedPattern = {
        ...s.pattern,
        tracks: s.pattern.tracks.map(track => {
          if (track.id !== trackId) return track;
          return {
            ...track,
            steps: track.steps.map((value, idx) =>
              idx === stepIdx ? !value : value
            ),
          };
        }),
      };
      return { ...s, pattern: updatedPattern };
    });
    save(updated);
  };

  const clearPattern = () => {
    if (!currentSong) return;
    const updated = songs.map(s =>
      s.id === currentSong.id
        ? { ...s, pattern: createEmptyPatternForSong() }
        : s
    );
    save(updated);
  };

  // ✅ Drag songs reorder
  const dragSongFrom = useRef(null);
  const allow = (e) => e.preventDefault();
  const songDragStart = (i) => () => (dragSongFrom.current = i);
  const songDrop = (to) => (e) => {
    e.preventDefault();
    const from = dragSongFrom.current;
    if (from == null || from === to) return;
    const reordered = [...songs];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    save(reordered);
    dragSongFrom.current = null;
  };

  // ✅ Drag sections reorder
  const dragFrom = useRef(null);
  const sectionDragStart = (i) => () => {
    if (!currentSong.sections[i].intro) dragFrom.current = i;
  };
  const sectionDrop = (to) => (e) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (from == null || to === from) return;
    if (currentSong.sections[to].intro) return;
    const updated = songs.map(s => {
      if (s.id !== currentSong.id) return s;
      const arr = [...s.sections];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...s, sections: arr };
    });
    save(updated);
    dragFrom.current = null;
  };

  // AUDIO
  const clickSound = (time, accent) => {
    const osc = audioContextRef.current.createOscillator();
    const gain = audioContextRef.current.createGain();
    osc.connect(gain);
    gain.connect(audioContextRef.current.destination);

    osc.frequency.value = accent ? 1400 : 900;
    gain.gain.value = 1;

    osc.start(time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.stop(time + 0.08);
  };

  const playInstrumentSound = (instrumentId, time) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    const buffer = sampleBufferRef.current[instrumentId];
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(time);
      return;
    }

    ensureSampleBuffer(instrumentId);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "triangle";
    osc.frequency.value = instrumentFrequencyMap[instrumentId] || 220;
    gain.gain.value = 1;

    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    osc.start(time);
    osc.stop(time + 0.12);
  };
// ФУНКЦИЯ ШЕДУЛЕР
 const schedule = () => {
  const ct = audioContextRef.current.currentTime;
  const lookahead = 0.1;
  
  while (nextNoteTimeRef.current < ct + lookahead) {
    const scheduledTime = nextNoteTimeRef.current;
    const currentBeatValue = beatRef.current;
    const currentBarValue = barRef.current;
    const pattern = currentSong?.pattern;
    const patternLength = pattern?.steps || PATTERN_STEPS;
    const totalBeatsPassed =
      currentBarValue * beatsPerBar + (currentBeatValue - 1);
    const usePatternSounds = pattern && patternHasActiveSteps(pattern);

    if (usePatternSounds && patternLength > 0) {
      const subDiv = 2;
      const subDuration = (60 / bpm) / subDiv;
      const baseStep = Math.floor(totalBeatsPassed * subDiv);

      for (let sub = 0; sub < subDiv; sub++) {
        const subTime = scheduledTime + sub * subDuration;
        const stepIndex = (baseStep + sub) % patternLength;

        pattern.tracks.forEach(track => {
          if (track.steps[stepIndex]) {
            playInstrumentSound(track.id, subTime);
          }
        });

        visualQueueRef.current.push({
          time: subTime,
          type: "beat",
          beat: currentBeatValue,
          bar: currentBarValue,
          patternStep: stepIndex,
        });
      }
    } else {
      visualQueueRef.current.push({
        time: scheduledTime,
        type: "beat",
        beat: currentBeatValue,
        bar: currentBarValue,
        patternStep: 0,
      });
      clickSound(scheduledTime, currentBeatValue === 1);
    }

    nextNoteTimeRef.current += 60 / bpm;

    if (beatRef.current === beatsPerBar) {
      beatRef.current = 1;
      barRef.current += 1;
      if (barRef.current >= totalBars(currentSong)) {
        visualQueueRef.current.push({
          time: scheduledTime + 0.001,
          type: "stop",
        });
        return;
      }
    } else beatRef.current += 1;
  }
  timerRef.current = setTimeout(schedule, 25);
};
// КОНЕЦ ШЕДУЛЕРА

  //СТАРТ
  const changeBpm = (delta) => {
    setBpm(prev => {
      const next = prev + delta;
      return Math.max(MIN_BPM, Math.min(MAX_BPM, next));
    });
  };

  const start = async () => {
    if (!currentSong) return;
    if (!audioContextRef.current)
      audioContextRef.current = new AudioContext();
    try {
      await Promise.all(
        PATTERN_INSTRUMENTS.map(inst => ensureSampleBuffer(inst.id))
      );
    } catch (err) {
      console.warn("Sample warmup failed:", err);
    }
    setIsPlaying(true);
    beatRef.current = 1;
    barRef.current = 0;
    setCurrentBeat(1);
    setCurrentBar(0);
    setCurrentPatternStep(0);
    visualQueueRef.current = [];
    nextNoteTimeRef.current = audioContextRef.current.currentTime;
    schedule();
  };

  //СТОП
  const stop = () => {
    setIsPlaying(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (visualRafRef.current) {
      cancelAnimationFrame(visualRafRef.current);
      visualRafRef.current = null;
    }
    visualQueueRef.current = [];
    setCurrentPatternStep(0);
  };

  useEffect(() => {
    if (!isPlaying) return;

    const processVisuals = () => {
      if (!audioContextRef.current) {
        visualRafRef.current = requestAnimationFrame(processVisuals);
        return;
      }

      const now = audioContextRef.current.currentTime;

      while (visualQueueRef.current.length && visualQueueRef.current[0].time <= now) {
        const event = visualQueueRef.current.shift();
        if (event.type === "stop") {
          setCurrentBeat(1);
          setCurrentBar(0);
          setCurrentPatternStep(0);
          setIsPlaying(false);
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          visualQueueRef.current = [];
          if (visualRafRef.current) {
            cancelAnimationFrame(visualRafRef.current);
            visualRafRef.current = null;
          }
          return;
        }

        setCurrentBeat(event.beat);
        setCurrentBar(event.bar);
        if (typeof event.patternStep === "number") {
          setCurrentPatternStep(event.patternStep);
        }
      }

      visualRafRef.current = requestAnimationFrame(processVisuals);
    };

    visualRafRef.current = requestAnimationFrame(processVisuals);

    return () => {
      if (visualRafRef.current) {
        cancelAnimationFrame(visualRafRef.current);
        visualRafRef.current = null;
      }
      visualQueueRef.current = [];
    };
  }, [isPlaying]);

  useEffect(() => stop, []);

  const ranges = currentSong
    ? (() => {
        let start = 0;
        return currentSong.sections.map(sec => {
          const end = start + sec.bars - 1;
          const out = { start, end };
          start = end + 1;
          return out;
        });
      })()
    : [];

  const currentSectionIndex =
    ranges.findIndex(r => currentBar >= r.start && currentBar <= r.end);

  useEffect(() => {
    if (isPlaying && currentSectionRef.current) {
      currentSectionRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [currentBar, isPlaying]);

  useEffect(() => {
    if (!currentSong) {
      setShowPatternEditor(false);
    }
  }, [currentSong]);

  // ====== UI RENDER ======
  const PatternEditorComponent = patternEditorReady ? window.PatternEditor : null;

  if (showPatternEditor && PatternEditorComponent && currentSong) {
    return (
      <PatternEditorComponent
        songName={currentSong.name}
        pattern={currentSong.pattern}
        currentStep={isPlaying ? currentPatternStep : -1}
        onToggleStep={togglePatternStep}
        onClear={clearPattern}
        onClose={() => setShowPatternEditor(false)}
      />
    );
  }

  // Если код не введён или неверный — показываем форму
  if (bandCode !== CORRECT_CODE) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white p-6 flex items-center justify-center">
        <div className="glass p-6 rounded-3xl w-full max-w-sm">
          <h1 className="text-2xl font-black mb-4">🔐 Доступ к группе</h1>
          <p className="opacity-90 mb-3">Введите код группы, чтобы увидеть и редактировать общие песни.</p>

          <input
            type="password"
            placeholder="Код группы"
            value={bandCodeInput}
            onChange={(e) => setBandCodeInput(e.target.value)}
            className="w-full p-3 rounded-xl bg-white/10 text-white mb-3 border border-white/20"
          />
          {codeError && <div className="text-red-300 text-sm mb-2">{codeError}</div>}

          <button
            onClick={handleSubmitCode}
            className="w-full p-3 rounded-xl bg-green-600 font-bold"
          >
            Войти
          </button>
        </div>

        <style>{`.glass{background:rgba(255,255,255,0.05);backdrop-filter:blur(15px);}`}</style>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-28 bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white p-6 flex flex-col items-center">
      <h1 className="text-3xl font-black mb-6">🎧 Metronome</h1>

     
      {!currentSong && (
        <>
          <div className="glass p-6 rounded-3xl w-full max-w-xl mb-6">
            <input
              type="text"
              placeholder="Song name"
              value={newSongName}
              onChange={(e) => setNewSongName(e.target.value)}
              className="w-full p-3 rounded-xl bg-white/10 text-white mb-3"
            />
            <button onClick={createSong} className="w-full p-3 rounded-xl bg-green-600 font-bold">➕ Add song</button>
          </div>

          {songs.map((song, i) => (
            <div
              key={song.id}
              className="flex gap-2 w-full max-w-xl mb-2"
              draggable
              onDragStart={songDragStart(i)}
              onDragOver={allow}
              onDrop={songDrop(i)}
            >
              <span className="cursor-grab select-none text-white/50">↕</span>
              <button onClick={() => selectSong(song)} className="flex-1 p-3 bg-white/10 hover:bg-white/20 rounded-xl">
                🎵 {song.name}
              </button>
              <button onClick={() => deleteSong(song.id)} className="p-3 bg-red-600 rounded-xl">🗑</button>
            </div>
          ))}
        </>
      )}

      {currentSong && (
        <div className="glass p-6 rounded-3xl w-full max-w-xl">
          <div className="flex justify-between mb-4">
            <h2 className="text-xl font-bold">{currentSong.name}</h2>
            <button onClick={() => { setCurrentSong(null); stop(); }} className="px-3 py-2 bg-purple-600 rounded-lg">
              ← Back
            </button>
          </div>

          <div className="space-y-3 mb-6">
            {currentSong.sections.map((sec, i) => {
              const isIntro = sec.intro;
              const isCurrentSection = i === currentSectionIndex;
              const range = ranges[i];

              return (
                <div
                  key={i}
                  ref={isCurrentSection ? currentSectionRef : null}
                  draggable={!isIntro}
                  onDragStart={sectionDragStart(i)}
                  onDragOver={allow}
                  onDrop={sectionDrop(i)}
                  className={`p-3 rounded-2xl border ${
                    isCurrentSection
                      ? "border-yellow-300 bg-yellow-200/20 shadow-[0_0_20px_rgba(255,255,0,0.7)]"
                      : "border-white/20 bg-white/10"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {!isIntro && <span className="px-1 cursor-grab select-none">↕</span>}
                    <span className="font-bold">{sec.name}</span>
                    <span className="opacity-80">{sec.bars} bars</span>
                    {!isIntro && (
                      <button onClick={() => removeSection(i)} className="ml-auto p-1 bg-red-600 rounded-lg">
                        🗑
                      </button>
                    )}
                  </div>

                  {sec.comment && (
                    <div className="text-white/90 font-bold text-lg mt-2">{sec.comment}</div>
                  )}

                 
              {/* ✅ Визуал блоков */}
              <div className="grid grid-cols-4 gap-1">
                {Array.from({ length: sec.bars * 4 }).map((_, idx) => {
                  const barNum = range.start + Math.floor(idx / 4);
                  const localBeat = (idx % 4) + 1;
                  const absClick = barNum * 4 + (localBeat - 1);
                  const currentAbs = currentBar * 4 + currentBeat - 1;
                  const isCurrent = absClick === currentAbs;
                  const isFilled = absClick <= currentAbs;
                  const isFirstBeat = localBeat === 1;

                  return (
                    <div
                      key={idx}
                      className={`
                        h-5 rounded-md transition-all duration-100
                        ${isFilled
                          ? isCurrent
                            ? 'bg-yellow-400/80 shadow-[0_0_10px_rgba(255,255,0,0.7)]'
                            : 'bg-green-500/70'
                          : isFirstBeat
                            ? 'bg-white/30 border-2 border-white/50'
                            : 'bg-white/15'
                        }
                      `}
                    ></div>
                  );
                })}
              </div>


                </div>
              );
            })}

            {/* ✅ ADD SECTION FORM UNDER SECTIONS */}
            {!showAddForm ? (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full py-3 mt-2 bg-blue-500 rounded-lg font-bold"
              >
                ➕ Add Section
              </button>
            ) : (
              <div className="p-3 rounded-xl bg-white/10 border border-white/20 space-y-3">
                <select
                  value={newSection.name}
                  onChange={(e) => setNewSection({ ...newSection, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white text-black rounded-lg"
                >
                  {sectionTypes.map(t => <option key={t}>{t}</option>)}
                </select>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="px-3 py-2 bg-white/10 rounded-lg border border-white/20"
                    onClick={() =>
                      setNewSection(prev => ({
                        ...prev,
                        bars: Math.max(1, (prev.bars || 1) - 1),
                      }))
                    }
                  >
                    −
                  </button>
                  <input
                    type="number"
                    value={newSection.bars}
                    onChange={(e) => setNewSection({ ...newSection, bars: Math.max(1, +e.target.value) })}
                    className="flex-1 px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20 text-center appearance-none focus:outline-none"
                    min={1}
                  />
                  <button
                    type="button"
                    className="px-3 py-2 bg-white/10 rounded-lg border border-white/20"
                    onClick={() =>
                      setNewSection(prev => ({
                        ...prev,
                        bars: Math.max(1, (prev.bars || 1) + 1),
                      }))
                    }
                  >
                    +
                  </button>
                </div>

                <input
                  type="text"
                  placeholder="Comment (optional)"
                  value={newSection.comment}
                  onChange={(e) => setNewSection({ ...newSection, comment: e.target.value })}
                  className="w-full px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20"
                />

                <div className="flex gap-3">
                  <button
                    onClick={addSection}
                    className="flex-1 py-2 bg-green-600 rounded-lg font-bold"
                  >
                    ✔ Save Section
                  </button>
                  <button
                    onClick={() => setShowAddForm(false)}
                    className="py-2 px-4 bg-gray-500 rounded-lg font-bold"
                  >
                    ✖
                  </button>
                </div>
              </div>
            )}
          </div>

          <label className="block opacity-80 mb-1">Tempo: {bpm} BPM</label>
          <input
            type="range"
            min={MIN_BPM}
            max={MAX_BPM}
            value={bpm}
            onChange={(e) => setBpm(+e.target.value)}
            className="w-full mb-2"
          />
          <div className="flex flex-col gap-2 mb-4">
            <div className="grid grid-cols-4 gap-2">
              <button
                className="py-2 bg-white/10 rounded-lg border border-white/20"
                onClick={() => changeBpm(-10)}
              >
                −10
              </button>
              <button
                className="py-2 bg-white/10 rounded-lg border border-white/20"
                onClick={() => changeBpm(-1)}
              >
                −1
              </button>
              <button
                className="py-2 bg-white/10 rounded-lg border border-white/20"
                onClick={() => changeBpm(1)}
              >
                +1
              </button>
              <button
                className="py-2 bg-white/10 rounded-lg border border-white/20"
                onClick={() => changeBpm(10)}
              >
                +10
              </button>
            </div>
            <button
              onClick={() => PatternEditorComponent && setShowPatternEditor(true)}
              disabled={!PatternEditorComponent}
              className={`w-full py-2 rounded-lg font-bold transition ${
                PatternEditorComponent
                  ? "bg-purple-600 hover:bg-purple-500"
                  : "bg-white/10 cursor-not-allowed opacity-60"
              }`}
            >
              Свой паттерн
            </button>
          </div>

          <div className="h-24" />
        </div>
      )}

      {currentSong && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-gradient-to-t from-indigo-900/80 via-blue-900/40 to-transparent">
          <div className="max-w-xl mx-auto px-6 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
            {!isPlaying ? (
              <button onClick={start} className="w-full py-4 bg-green-600 rounded-xl text-xl font-bold shadow-2xl">
                ▶ START
              </button>
            ) : (
              <button onClick={stop} className="w-full py-4 bg-red-600 rounded-xl text-xl font-bold shadow-2xl">
                ⏹ STOP
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(15px); }
      `}</style>
    </div>
  );
}

ReactDOM.render(<App />, document.getElementById("root"));
