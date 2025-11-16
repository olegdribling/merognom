// ✅ OPTIMIZED & SECURE VERSION
const { useState, useRef, useEffect, useCallback } = React;

const APP_VERSION = "2024.12.23";
const VERSION_KEY = "app_version";
const RELOAD_FLAG = "app_version_reloading";

// ✅ Configuration
const CONFIG = {
  CORRECT_CODE: "0000",
  MAX_SONGS: 50,
  MAX_SECTIONS: 20,
  MAX_SONG_NAME_LENGTH: 100,
  MAX_COMMENT_LENGTH: 200,
  MIN_BPM: 40,
  MAX_BPM: 240,
  BEATS_PER_BAR: 4,
  FIRESTORE_COLLECTION: "bands",
  SAVE_DEBOUNCE_MS: 1000,
  MAX_DOCUMENT_SIZE: 900000, // 900KB (Firestore limit 1MB)
};

const patternGlobals = window.MetronomePattern || {};
const SAMPLES_BASE = "sound/Real Drum Kit";
const PATTERN_INSTRUMENTS = patternGlobals.PATTERN_INSTRUMENTS || [
  { id: "bd", label: "BD", color: "#fb923c", freq: 120, sample: `${SAMPLES_BASE}/BD.wav` },
  { id: "sd", label: "SD", color: "#facc15", freq: 220, sample: `${SAMPLES_BASE}/SN.wav` },
  { id: "hh", label: "HH", color: "#60a5fa", freq: 450, sample: `${SAMPLES_BASE}/HH.wav` },
];
const PATTERN_STEPS = patternGlobals.PATTERN_STEPS || 16;

// ✅ Utilities with validation
const sanitizeString = (str, maxLength) => {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLength);
};

const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

const normalizePattern = (pattern) => {
  const steps = pattern?.steps && pattern.steps > 0 ? pattern.steps : PATTERN_STEPS;
  const tracks = pattern?.tracks || [];
  return {
    steps,
    tracks: PATTERN_INSTRUMENTS.map(inst => {
      const existing = tracks.find(t => t.id === inst.id) || tracks.find(t => t.name === inst.label);
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
  id: song?.id || Date.now(),
  name: sanitizeString(song?.name, CONFIG.MAX_SONG_NAME_LENGTH) || 'Untitled',
  sections: (song?.sections || [])
    .slice(0, CONFIG.MAX_SECTIONS)
    .map(sec => ({
      ...sec,
      name: sanitizeString(sec?.name, 50),
      comment: sanitizeString(sec?.comment, CONFIG.MAX_COMMENT_LENGTH),
      bars: Math.max(1, Math.min(16, Number(sec?.bars) || 1)),
      intro: Boolean(sec?.intro),
    })),
  pattern: normalizePattern(song?.pattern),
});

const ensureSongsStructure = (songs = []) => {
  if (!Array.isArray(songs)) return [];
  return songs.slice(0, CONFIG.MAX_SONGS).map(normalizeSong);
};

const createEmptyPattern = () => normalizePattern({
  steps: PATTERN_STEPS,
  tracks: PATTERN_INSTRUMENTS.map(inst => ({
    id: inst.id,
    name: inst.label,
    color: inst.color,
    sample: inst.sample,
    steps: Array(PATTERN_STEPS).fill(false),
  })),
});

const patternHasActiveSteps = (pattern) =>
  !!pattern?.tracks?.some(track => track.steps.some(Boolean));

const instrumentFrequencyMap = PATTERN_INSTRUMENTS.reduce((acc, inst) => {
  acc[inst.id] = inst.freq || 220;
  return acc;
}, {});

const instrumentMetaById = PATTERN_INSTRUMENTS.reduce((acc, inst) => {
  acc[inst.id] = inst;
  return acc;
}, {});

function App() {
  // ====== GROUP CODE GATE ======
  const [bandCodeInput, setBandCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [bandCode, setBandCode] = useState(() => localStorage.getItem("band_code") || "");

  const handleSubmitCode = () => {
    if (bandCodeInput.trim() === CONFIG.CORRECT_CODE) {
      localStorage.setItem("band_code", CONFIG.CORRECT_CODE);
      setBandCode(CONFIG.CORRECT_CODE);
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

  // ====== STATE ======
  const [songs, setSongs] = useState(() => {
    const saved = localStorage.getItem("songs_final2");
    return saved ? ensureSongsStructure(JSON.parse(saved)) : [];
  });

  const [currentSong, setCurrentSong] = useState(null);
  const [newSongName, setNewSongName] = useState("");
  const [syncError, setSyncError] = useState(null);
  const [pendingSave, setPendingSave] = useState(false);

  const sectionTypes = ["INTRO", "VERSE", "PRECHORUS", "CHORUS", "POSTCHORUS", "BRIDGE", "SOLO", "OUTRO", "PAUSE"];
  const [newSection, setNewSection] = useState({ name: "VERSE", bars: 4, comment: "" });
  const [showAddForm, setShowAddForm] = useState(false);

  const [bpm, setBpm] = useState(120);
  const [playbackState, setPlaybackState] = useState({ beat: 1, bar: 0, patternStep: 0 });
  const [isPlaying, setIsPlaying] = useState(false);
  const [showPatternEditor, setShowPatternEditor] = useState(false);
  const [patternEditorReady, setPatternEditorReady] = useState(() => Boolean(window.PatternEditor));
  const [samplesLoaded, setSamplesLoaded] = useState(false);

  // ====== REFS ======
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
  const saveTimeoutRef = useRef(null);

  const totalBars = song => song ? song.sections.reduce((s, sec) => s + sec.bars, 0) : 0;

  // ====== AUDIO SAMPLE LOADING ======
  const fetchSampleData = useCallback((instrumentId) => {
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
  }, []);

  const ensureSampleBuffer = useCallback(async (instrumentId) => {
    if (sampleBufferRef.current[instrumentId]) {
      return sampleBufferRef.current[instrumentId];
    }
    if (sampleDecodePromisesRef.current[instrumentId]) {
      return sampleDecodePromisesRef.current[instrumentId];
    }
    if (!audioContextRef.current) return null;

    const data = sampleDataRef.current[instrumentId] || (await fetchSampleData(instrumentId));
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
  }, [fetchSampleData]);

  // ✅ Preload all samples when song is selected
  const preloadAllSamples = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    
    try {
      await Promise.all(
        PATTERN_INSTRUMENTS.map(inst => ensureSampleBuffer(inst.id))
      );
      setSamplesLoaded(true);
    } catch (err) {
      console.warn("Sample preload failed:", err);
      setSamplesLoaded(false);
    }
  }, [ensureSampleBuffer]);

  // ✅ Preload samples on mount
  useEffect(() => {
    PATTERN_INSTRUMENTS.forEach(inst => {
      if (inst.sample) {
        fetchSampleData(inst.id);
      }
    });
  }, [fetchSampleData]);

  // ✅ Preload samples when song selected
  useEffect(() => {
    if (currentSong) {
      preloadAllSamples();
    }
  }, [currentSong, preloadAllSamples]);

  // ✅ Pattern editor ready check
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

  // ✅ Version management with proper cleanup
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
        // ✅ Always set flag even if cleanup fails
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

  // ✅ Debounced save to Firestore
  const saveToFirestore = useCallback(
    debounce(async (songsToSave) => {
      if (bandCode !== CONFIG.CORRECT_CODE) return;
      
      try {
        const dataSize = JSON.stringify(songsToSave).length;
        if (dataSize > CONFIG.MAX_DOCUMENT_SIZE) {
          console.warn("Data too large for Firestore:", dataSize, "bytes");
          setSyncError("Данные слишком большие. Удалите некоторые песни.");
          return;
        }

        await window.db.collection(CONFIG.FIRESTORE_COLLECTION).doc(bandCode).set({
          songs: songsToSave,
          updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
        });
        setSyncError(null);
      } catch (e) {
        console.warn("Cloud save failed:", e);
        setSyncError("Ошибка сохранения. Проверьте интернет.");
      } finally {
        setPendingSave(false);
      }
    }, CONFIG.SAVE_DEBOUNCE_MS),
    [bandCode]
  );

  // ✅ Firestore realtime sync with conflict handling
  useEffect(() => {
    if (bandCode !== CONFIG.CORRECT_CODE || !window.db) return;
    
    const docRef = window.db.collection(CONFIG.FIRESTORE_COLLECTION).doc(bandCode);

    const unsub = docRef.onSnapshot(
      (doc) => {
        // ✅ Don't overwrite if we're saving
        if (pendingSave) return;
        
        const data = doc.data();
        if (data && Array.isArray(data.songs)) {
          const normalized = ensureSongsStructure(data.songs);
          setSongs(normalized);
          localStorage.setItem("songs_final2", JSON.stringify(normalized));
          setCurrentSong(prev => {
            if (!prev) return prev;
            return normalized.find(s => s.id === prev.id) || null;
          });
          setSyncError(null);
        } else {
          // ✅ Initialize empty document
          docRef.set({ 
            songs: [], 
            updatedAt: window.firebase.firestore.FieldValue.serverTimestamp() 
          }).catch(err => {
            console.warn("Failed to initialize document:", err);
          });
        }
      },
      (err) => {
        console.warn("Firestore listener error:", err);
        setSyncError("Ошибка синхронизации. Проверьте интернет.");
      }
    );

    return () => unsub();
  }, [bandCode, pendingSave]);

  // ✅ Save function with debouncing
  const save = useCallback((updatedSongs, updated = currentSong) => {
    const normalized = ensureSongsStructure(updatedSongs);
    setSongs(normalized);
    localStorage.setItem("songs_final2", JSON.stringify(normalized));

    if (bandCode === CONFIG.CORRECT_CODE) {
      setPendingSave(true);
      saveToFirestore(normalized);
    }

    if (updated) {
      setCurrentSong(normalized.find(s => s.id === updated.id));
    }
  }, [currentSong, bandCode, saveToFirestore]);

  // ====== SONG OPERATIONS ======
  const createSong = () => {
    if (!newSongName.trim()) return;
    const song = {
      id: Date.now(),
      name: newSongName.trim(),
      sections: [{ name: "1 2 3 4", bars: 2, intro: true }],
      pattern: createEmptyPattern(),
    };
    save([...songs, song]);
    setNewSongName("");
  };

  const selectSong = (song) => {
    stop();
    setCurrentSong(song);
    setPlaybackState({ beat: 1, bar: 0, patternStep: 0 });
    setShowPatternEditor(false);
  };

  const deleteSong = (id) => {
    const song = songs.find(s => s.id === id);
    if (!song) return;
    
    const confirmed = window.confirm(
      `Удалить песню "${song.name}"?\n\nЭто действие нельзя отменить.`
    );
    
    if (!confirmed) return;
    
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
    if (!currentSong || currentSong.sections[i].intro) return;
    const updated = songs.map(s =>
      s.id === currentSong.id
        ? { ...s, sections: s.sections.filter((_, idx) => idx !== i) }
        : s
    );
    save(updated);
  };

  const togglePatternStep = useCallback((trackId, stepIdx) => {
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
  }, [currentSong, songs, save]);

  const clearPattern = () => {
    if (!currentSong) return;
    const updated = songs.map(s =>
      s.id === currentSong.id
        ? { ...s, pattern: createEmptyPattern() }
        : s
    );
    save(updated);
  };

  // ====== DRAG & DROP (Desktop + Mobile) ======
  const dragSongFrom = useRef(null);
  const touchStartY = useRef(null);
  const draggedElement = useRef(null);
  
  const allow = (e) => e.preventDefault();
  
  // Desktop drag
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

  // Mobile touch
  const songTouchStart = (i) => (e) => {
    dragSongFrom.current = i;
    touchStartY.current = e.touches[0].clientY;
    draggedElement.current = e.currentTarget;
    draggedElement.current.style.opacity = '0.5';
  };

  const songTouchMove = (e) => {
    if (dragSongFrom.current == null) return;
    e.preventDefault();
    const touch = e.touches[0];
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    
    // Найти индекс элемента под пальцем
    const songItems = document.querySelectorAll('[data-song-index]');
    songItems.forEach((item, idx) => {
      if (item.contains(element) && idx !== dragSongFrom.current) {
        item.style.borderTop = '3px solid #60a5fa';
      } else {
        item.style.borderTop = '';
      }
    });
  };

  const songTouchEnd = (e) => {
    if (dragSongFrom.current == null) return;
    
    const touch = e.changedTouches[0];
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    
    // Найти индекс drop target
    const songItems = document.querySelectorAll('[data-song-index]');
    let dropIndex = null;
    songItems.forEach((item, idx) => {
      item.style.borderTop = '';
      if (item.contains(element)) {
        dropIndex = idx;
      }
    });

    if (dropIndex != null && dropIndex !== dragSongFrom.current) {
      const reordered = [...songs];
      const [moved] = reordered.splice(dragSongFrom.current, 1);
      reordered.splice(dropIndex, 0, moved);
      save(reordered);
    }

    if (draggedElement.current) {
      draggedElement.current.style.opacity = '1';
    }
    
    dragSongFrom.current = null;
    touchStartY.current = null;
    draggedElement.current = null;
  };

  // Sections drag & drop
  const dragFrom = useRef(null);
  const sectionTouchStartY = useRef(null);
  const draggedSection = useRef(null);

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

  // Mobile touch for sections
  const sectionTouchStart = (i) => (e) => {
    if (currentSong.sections[i].intro) return;
    dragFrom.current = i;
    sectionTouchStartY.current = e.touches[0].clientY;
    draggedSection.current = e.currentTarget;
    draggedSection.current.style.opacity = '0.5';
  };

  const sectionTouchMove = (e) => {
    if (dragFrom.current == null) return;
    e.preventDefault();
    const touch = e.touches[0];
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    
    const sectionItems = document.querySelectorAll('[data-section-index]');
    sectionItems.forEach((item, idx) => {
      const isIntro = currentSong.sections[idx]?.intro;
      if (item.contains(element) && idx !== dragFrom.current && !isIntro) {
        item.style.borderTop = '3px solid #60a5fa';
      } else {
        item.style.borderTop = '';
      }
    });
  };

  const sectionTouchEnd = (e) => {
    if (dragFrom.current == null) return;
    
    const touch = e.changedTouches[0];
    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    
    const sectionItems = document.querySelectorAll('[data-section-index]');
    let dropIndex = null;
    sectionItems.forEach((item, idx) => {
      item.style.borderTop = '';
      if (item.contains(element) && !currentSong.sections[idx]?.intro) {
        dropIndex = idx;
      }
    });

    if (dropIndex != null && dropIndex !== dragFrom.current) {
      const updated = songs.map(s => {
        if (s.id !== currentSong.id) return s;
        const arr = [...s.sections];
        const [moved] = arr.splice(dragFrom.current, 1);
        arr.splice(dropIndex, 0, moved);
        return { ...s, sections: arr };
      });
      save(updated);
    }

    if (draggedSection.current) {
      draggedSection.current.style.opacity = '1';
    }
    
    dragFrom.current = null;
    sectionTouchStartY.current = null;
    draggedSection.current = null;
  };

  // ====== AUDIO PLAYBACK ======
  const clickSound = useCallback((time, accent) => {
    if (!audioContextRef.current) return;
    const osc = audioContextRef.current.createOscillator();
    const gain = audioContextRef.current.createGain();
    osc.connect(gain);
    gain.connect(audioContextRef.current.destination);

    osc.frequency.value = accent ? 1400 : 900;
    gain.gain.value = 1;

    osc.start(time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.stop(time + 0.08);
  }, []);

  const playInstrumentSound = useCallback((instrumentId, time) => {
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

    // ✅ Fallback only if sample not loaded yet
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "triangle";
    osc.frequency.value = instrumentFrequencyMap[instrumentId] || 220;
    gain.gain.value = 0.5; // Lower volume for fallback

    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    osc.start(time);
    osc.stop(time + 0.12);
  }, []);

  const schedule = useCallback(() => {
    const ct = audioContextRef.current.currentTime;
    const lookahead = 0.1;
    
    while (nextNoteTimeRef.current < ct + lookahead) {
      const scheduledTime = nextNoteTimeRef.current;
      const currentBeatValue = beatRef.current;
      const currentBarValue = barRef.current;
      const pattern = currentSong?.pattern;
      const patternLength = pattern?.steps || PATTERN_STEPS;
      const totalBeatsPassed = currentBarValue * CONFIG.BEATS_PER_BAR + (currentBeatValue - 1);
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

      if (beatRef.current === CONFIG.BEATS_PER_BAR) {
        beatRef.current = 1;
        barRef.current += 1;
        if (barRef.current >= totalBars(currentSong)) {
          visualQueueRef.current.push({
            time: scheduledTime + 0.001,
            type: "stop",
          });
          return;
        }
      } else {
        beatRef.current += 1;
      }
    }
    timerRef.current = setTimeout(schedule, 25);
  }, [bpm, currentSong, clickSound, playInstrumentSound]);

  const changeBpm = (delta) => {
    setBpm(prev => {
      const next = prev + delta;
      return Math.max(CONFIG.MIN_BPM, Math.min(CONFIG.MAX_BPM, next));
    });
  };

  const start = async () => {
    if (!currentSong) return;
    
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    
    // ✅ Resume AudioContext if suspended (mobile browsers)
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    setIsPlaying(true);
    beatRef.current = 1;
    barRef.current = 0;
    setPlaybackState({ beat: 1, bar: 0, patternStep: 0 });
    visualQueueRef.current = [];
    nextNoteTimeRef.current = audioContextRef.current.currentTime;
    schedule();
  };

  const stop = useCallback(() => {
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
    setPlaybackState({ beat: 1, bar: 0, patternStep: 0 });
  }, []);

  // ✅ Visual update loop (optimized - single state update)
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
          setPlaybackState({ beat: 1, bar: 0, patternStep: 0 });
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

        // ✅ Single state update instead of 3 separate ones
        setPlaybackState({
          beat: event.beat,
          bar: event.bar,
          patternStep: typeof event.patternStep === "number" ? event.patternStep : 0
        });
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

  // ✅ Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [stop]);

  // ✅ Auto-scroll to current section
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

  const currentSectionIndex = ranges.findIndex(
    r => playbackState.bar >= r.start && playbackState.bar <= r.end
  );

  useEffect(() => {
    if (isPlaying && currentSectionRef.current) {
      currentSectionRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [playbackState.bar, isPlaying]);

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
        currentStep={isPlaying ? playbackState.patternStep : -1}
        onToggleStep={togglePatternStep}
        onClear={clearPattern}
        onClose={() => setShowPatternEditor(false)}
      />
    );
  }

  // ====== CODE GATE UI ======
  if (bandCode !== CONFIG.CORRECT_CODE) {
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
            onKeyPress={(e) => e.key === 'Enter' && handleSubmitCode()}
            className="w-full p-3 rounded-xl bg-white/10 text-white mb-3 border border-white/20"
          />
          {codeError && <div className="text-red-300 text-sm mb-2">{codeError}</div>}

          <button
            onClick={handleSubmitCode}
            className="w-full p-3 rounded-xl bg-green-600 font-bold hover:bg-green-500 transition"
          >
            Войти
          </button>
        </div>

        <style>{`.glass{background:rgba(255,255,255,0.05);backdrop-filter:blur(15px);}`}</style>
      </div>
    );
  }

  // ====== MAIN APP UI ======
  return (
    <div className="min-h-screen pb-28 bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white p-6 flex flex-col items-center">
      <h1 className="text-3xl font-black mb-6">🎧 Metronome</h1>

      {/* ✅ Sync error indicator */}
      {syncError && (
        <div className="glass p-4 rounded-2xl w-full max-w-xl mb-4 bg-red-500/20 border border-red-500/50">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚠️</span>
            <span className="flex-1">{syncError}</span>
          </div>
        </div>
      )}

      {/* ✅ Pending save indicator */}
      {pendingSave && (
        <div className="glass p-3 rounded-2xl w-full max-w-xl mb-4 bg-blue-500/20 border border-blue-500/50">
          <div className="flex items-center gap-2">
            <span className="animate-spin">⏳</span>
            <span>Сохранение...</span>
          </div>
        </div>
      )}

      {!currentSong && (
        <>
          <div className="glass p-6 rounded-3xl w-full max-w-xl mb-6">
            <input
              type="text"
              placeholder="Song name"
              value={newSongName}
              onChange={(e) => setNewSongName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createSong()}
              maxLength={CONFIG.MAX_SONG_NAME_LENGTH}
              className="w-full p-3 rounded-xl bg-white/10 text-white mb-3 border border-white/20 focus:border-white/40 focus:outline-none transition"
            />
            <button 
              onClick={createSong} 
              disabled={!newSongName.trim()}
              className="w-full p-3 rounded-xl bg-green-600 font-bold hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              ➕ Add song
            </button>
          </div>

          {songs.length === 0 && (
            <div className="text-white/60 text-center mt-8">
              <p className="text-lg mb-2">Нет песен</p>
              <p className="text-sm">Создайте первую песню выше</p>
            </div>
          )}

          {songs.map((song, i) => (
            <div
              key={song.id}
              data-song-index={i}
              className="flex gap-2 w-full max-w-xl mb-2"
              draggable
              onDragStart={songDragStart(i)}
              onDragOver={allow}
              onDrop={songDrop(i)}
              onTouchStart={songTouchStart(i)}
              onTouchMove={songTouchMove}
              onTouchEnd={songTouchEnd}
            >
              <span className="cursor-grab select-none text-white/50 flex items-center touch-none">↕</span>
              <button 
                onClick={() => selectSong(song)} 
                className="flex-1 p-3 bg-white/10 hover:bg-white/20 rounded-xl transition text-left"
              >
                🎵 {song.name}
              </button>
              <button 
                onClick={() => deleteSong(song.id)} 
                className="p-3 bg-red-600 hover:bg-red-500 rounded-xl transition"
              >
                🗑
              </button>
            </div>
          ))}
        </>
      )}

      {currentSong && (
        <div className="glass p-6 rounded-3xl w-full max-w-xl">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold truncate flex-1">{currentSong.name}</h2>
            <button 
              onClick={() => { setCurrentSong(null); stop(); }} 
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg transition ml-3"
            >
              ← Back
            </button>
          </div>

          <div className="space-y-3 mb-6 max-h-[50vh] overflow-y-auto pr-2">
            {currentSong.sections.map((sec, i) => {
              const isIntro = sec.intro;
              const isCurrentSection = i === currentSectionIndex;
              const range = ranges[i];

              return (
                <div
                  key={i}
                  data-section-index={i}
                  ref={isCurrentSection ? currentSectionRef : null}
                  draggable={!isIntro}
                  onDragStart={sectionDragStart(i)}
                  onDragOver={allow}
                  onDrop={sectionDrop(i)}
                  onTouchStart={sectionTouchStart(i)}
                  onTouchMove={sectionTouchMove}
                  onTouchEnd={sectionTouchEnd}
                  className={`p-3 rounded-2xl border transition-all ${
                    isCurrentSection
                      ? "border-yellow-300 bg-yellow-200/20 shadow-[0_0_20px_rgba(255,255,0,0.7)]"
                      : "border-white/20 bg-white/10"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {!isIntro && <span className="px-1 cursor-grab select-none text-white/70 touch-none">↕</span>}
                    <span className="font-bold">{sec.name}</span>
                    <span className="opacity-80 text-sm">{sec.bars} bars</span>
                    {!isIntro && (
                      <button 
                        onClick={() => removeSection(i)} 
                        className="ml-auto p-1 px-2 bg-red-600 hover:bg-red-500 rounded-lg transition text-sm"
                      >
                        🗑
                      </button>
                    )}
                  </div>

                  {sec.comment && (
                    <div className="text-white/90 font-bold text-lg mt-2 mb-2">{sec.comment}</div>
                  )}

                  <div className="grid grid-cols-4 gap-1">
                    {Array.from({ length: sec.bars * 4 }).map((_, idx) => {
                      const barNum = range.start + Math.floor(idx / 4);
                      const localBeat = (idx % 4) + 1;
                      const absClick = barNum * 4 + (localBeat - 1);
                      const currentAbs = playbackState.bar * 4 + playbackState.beat - 1;
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

            {!showAddForm ? (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full py-3 mt-2 bg-blue-500 hover:bg-blue-400 rounded-lg font-bold transition"
              >
                ➕ Add Section
              </button>
            ) : (
              <div className="p-3 rounded-xl bg-white/10 border border-white/20 space-y-3">
                <select
                  value={newSection.name}
                  onChange={(e) => setNewSection({ ...newSection, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white text-black rounded-lg focus:outline-none"
                >
                  {sectionTypes.map(t => <option key={t}>{t}</option>)}
                </select>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
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
                    className="flex-1 px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20 text-center appearance-none focus:outline-none focus:border-white/40 transition"
                    min={1}
                    max={16}
                  />
                  <button
                    type="button"
                    className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
                    onClick={() =>
                      setNewSection(prev => ({
                        ...prev,
                        bars: Math.min(16, (prev.bars || 1) + 1),
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
                  maxLength={CONFIG.MAX_COMMENT_LENGTH}
                  className="w-full px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20 focus:outline-none focus:border-white/40 transition"
                />

                <div className="flex gap-3">
                  <button
                    onClick={addSection}
                    className="flex-1 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold transition"
                  >
                    ✔ Save Section
                  </button>
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setNewSection({ name: "VERSE", bars: 4, comment: "" });
                    }}
                    className="py-2 px-4 bg-gray-500 hover:bg-gray-400 rounded-lg font-bold transition"
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
            min={CONFIG.MIN_BPM}
            max={CONFIG.MAX_BPM}
            value={bpm}
            onChange={(e) => setBpm(+e.target.value)}
            className="w-full mb-2"
          />
          <div className="flex flex-col gap-2 mb-4">
            <div className="grid grid-cols-4 gap-2">
              <button
                className="py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
                onClick={() => changeBpm(-10)}
              >
                −10
              </button>
              <button
                className="py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
                onClick={() => changeBpm(-1)}
              >
                −1
              </button>
              <button
                className="py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
                onClick={() => changeBpm(1)}
              >
                +1
              </button>
              <button
                className="py-2 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20 transition"
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
              {samplesLoaded ? "🎵 Свой паттерн" : "⏳ Загрузка сэмплов..."}
            </button>
          </div>

          <div className="h-24" />
        </div>
      )}

      {currentSong && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-gradient-to-t from-indigo-900/95 via-blue-900/60 to-transparent backdrop-blur-sm">
          <div className="max-w-xl mx-auto px-6 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
            {!isPlaying ? (
              <button 
                onClick={start} 
                className="w-full py-4 bg-green-600 hover:bg-green-500 rounded-xl text-xl font-bold shadow-2xl transition active:scale-95"
              >
                ▶ START
              </button>
            ) : (
              <button 
                onClick={stop} 
                className="w-full py-4 bg-red-600 hover:bg-red-500 rounded-xl text-xl font-bold shadow-2xl transition active:scale-95"
              >
                ⏹ STOP
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(15px); }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type="number"] {
          -moz-appearance: textfield;
        }
        /* Smooth scrollbar */
        ::-webkit-scrollbar {
          width: 8px;
        }
        ::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.05);
          border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.3);
        }
      `}</style>
    </div>
  );
}

ReactDOM.render(<App />, document.getElementById("root"));
