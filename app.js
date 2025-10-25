// ✅ Metronome + Firebase Firestore (Realtime, Variant A: all can edit)
// Требования: index.html уже содержит firebase-app-compat, firebase-firestore-compat, firebase-auth-compat
// и инициализацию firebase.initializeApp(firebaseConfig); см. предыдущее сообщение.

const { useState, useRef, useEffect } = React;

// --- Firestore helpers ---
const db = firebase.firestore();
const auth = firebase.auth();

function App() {
  // ---------- Auth (анонимный вход, чтобы были права на запись/чтение) ----------
  const [authReady, setAuthReady] = useState(false);
  const [displayName, setDisplayName] = useState(() => {
    // локально храним имя участника, для поля "updatedBy"
    try {
      return localStorage.getItem("metronome_display_name") || "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    // Мягко: если не авторизован — входим анонимно
    const unsub = auth.onAuthStateChanged(async (u) => {
      if (!u) {
        try {
          await auth.signInAnonymously();
        } catch (e) {
          console.error("Anonymous auth error:", e);
        }
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("metronome_display_name", displayName || "");
    } catch {}
  }, [displayName]);

  // ---------- Songs (из Firestore) ----------
  const [songs, setSongs] = useState([]);         // [{id, name, sections, order, ...}]
  const [currentSongId, setCurrentSongId] = useState(null);
  const [newSongName, setNewSongName] = useState("");

  // форма Add Section (показывается по клику)
  const [showAddForm, setShowAddForm] = useState(false);
  const sectionTypes = ["INTRO", "VERSE", "PRECHORUS", "CHORUS", "POSTCHORUS", "BRIDGE", "SOLO", "OUTRO", "PAUSE"];
  const [newSection, setNewSection] = useState({ name: "VERSE", bars: 4, comment: "" });

  // ---------- Metronome ----------
  const [bpm, setBpm] = useState(120);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(1);
  const [currentBar, setCurrentBar] = useState(0);

  const beatsPerBar = 4;
  const audioContextRef = useRef(null);
  const timerRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(1);
  const barRef = useRef(0);
  const currentSectionRef = useRef(null);

  // ---------- Подписка на Firestore ----------
  useEffect(() => {
    if (!authReady) return;
    // Реальное время: слушаем всю коллекцию и сортируем по order
    const unsub = db
      .collection("songs")
      .orderBy("order", "asc")
      .onSnapshot((snap) => {
        const list = [];
        snap.forEach((doc) => {
          const d = doc.data();
          list.push({
            id: doc.id,
            name: d.name || "Untitled",
            sections: Array.isArray(d.sections) ? d.sections : [],
            order: typeof d.order === "number" ? d.order : Number.MAX_SAFE_INTEGER,
            updatedAt: d.updatedAt || null,
            updatedBy: d.updatedBy || "",
            createdAt: d.createdAt || null,
          });
        });
        setSongs(list);
        // если выбрана песня — обновим ссылку на её объект
        if (currentSongId) {
          const exists = list.find((s) => s.id === currentSongId);
          if (!exists) {
            // песню удалили
            stop();
            setCurrentSongId(null);
          }
        }
      }, (err) => {
        console.error("Firestore realtime error:", err);
      });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  // текущая песня из списка
  const currentSong = currentSongId ? songs.find((s) => s.id === currentSongId) : null;

  // ---------- Вспомогательное ----------
  const totalBars = (song) => song ? song.sections.reduce((sum, sec) => sum + (Number(sec.bars) || 0), 0) : 0;

  const nowTs = () => Date.now();
  const actor = () => displayName?.trim() || "anonymous";

  // ---------- CRUD: Songs ----------
  const createSong = async () => {
    if (!newSongName.trim()) return;

    // вычислим следующий order (в конец)
    const nextOrder = songs.length > 0 ? (Math.max(...songs.map(s => s.order || 0)) + 1) : 0;

    const doc = {
      name: newSongName.trim(),
      sections: [{ name: "1 2 3 4", bars: 2, intro: true }],
      order: nextOrder,
      createdAt: nowTs(),
      updatedAt: nowTs(),
      updatedBy: actor(),
    };
    try {
      const ref = await db.collection("songs").add(doc);
      setNewSongName("");
      // автоматически открываем новую песню
      stop();
      setCurrentSongId(ref.id);
      setCurrentBeat(1);
      setCurrentBar(0);
    } catch (e) {
      console.error("Create song error:", e);
    }
  };

  const selectSong = (song) => {
    stop();
    setCurrentSongId(song.id);
    setCurrentBeat(1);
    setCurrentBar(0);
  };

  const deleteSong = async (id) => {
    try {
      await db.collection("songs").doc(id).delete();
      if (currentSongId === id) {
        stop();
        setCurrentSongId(null);
      }
    } catch (e) {
      console.error("Delete song error:", e);
    }
  };

  // Перестановка песен (Drag & Drop): сохраняем новые order индексы
  const dragSongFrom = useRef(null);
  const allow = (e) => e.preventDefault();
  const songDragStart = (i) => () => (dragSongFrom.current = i);
  const songDrop = (to) => async (e) => {
    e.preventDefault();
    const from = dragSongFrom.current;
    if (from == null || from === to) return;

    const reordered = [...songs];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);

    // батч апдейт order = индекс
    const batch = db.batch();
    reordered.forEach((s, idx) => {
      const ref = db.collection("songs").doc(s.id);
      batch.update(ref, { order: idx, updatedAt: nowTs(), updatedBy: actor() });
    });

    try {
      await batch.commit();
    } catch (e) {
      console.error("Reorder songs error:", e);
    }
    dragSongFrom.current = null;
  };

  // ---------- Секции (массив внутри песни) ----------
  const addSection = async () => {
    if (!currentSong) return;
    const newSec = {
      ...newSection,
      bars: Math.max(1, Number(newSection.bars) || 1),
      intro: false,
    };

    const updatedSections = [...currentSong.sections, newSec];
    try {
      await db.collection("songs").doc(currentSong.id).update({
        sections: updatedSections,
        updatedAt: nowTs(),
        updatedBy: actor(),
      });
      setShowAddForm(false);
      setNewSection({ name: "VERSE", bars: 4, comment: "" });
    } catch (e) {
      console.error("Add section error:", e);
    }
  };

  const removeSection = async (i) => {
    if (!currentSong) return;
    if (currentSong.sections[i]?.intro) return; // INTRO нельзя удалять

    const updatedSections = currentSong.sections.filter((_, idx) => idx !== i);
    try {
      await db.collection("songs").doc(currentSong.id).update({
        sections: updatedSections,
        updatedAt: nowTs(),
        updatedBy: actor(),
      });
    } catch (e) {
      console.error("Remove section error:", e);
    }
  };

  // Перестановка секций (Drag & Drop)
  const dragFrom = useRef(null);
  const sectionDragStart = (i) => () => {
    if (!currentSong?.sections[i]?.intro) dragFrom.current = i;
  };
  const sectionDrop = (to) => async (e) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (from == null || from === to) return;
    if (currentSong?.sections[to]?.intro) return;

    const arr = [...(currentSong?.sections || [])];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);

    try {
      await db.collection("songs").doc(currentSong.id).update({
        sections: arr,
        updatedAt: nowTs(),
        updatedBy: actor(),
      });
    } catch (e) {
      console.error("Reorder sections error:", e);
    }
    dragFrom.current = null;
  };

  // ---------- AUDIO ----------
  const clickSound = (time, accent) => {
    if (!audioContextRef.current) return;
    const osc = audioContextRef.current.createOscillator();
    const gain = audioContextRef.current.createGain();
    osc.connect(gain);
    gain.connect(audioContextRef.current.destination);

    osc.frequency.value = accent ? 1400 : 900;
    gain.gain.value = accent ? 0.55 : 0.2;

    osc.start(time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.stop(time + 0.08);
  };

  const schedule = () => {
    if (!audioContextRef.current) return;
    if (!currentSong) return;

    const ct = audioContextRef.current.currentTime;
    while (nextNoteTimeRef.current < ct + 0.1) {
      clickSound(nextNoteTimeRef.current, beatRef.current === 1);
      setCurrentBeat(beatRef.current);
      setCurrentBar(barRef.current);

      nextNoteTimeRef.current += 60 / bpm;

      if (beatRef.current === beatsPerBar) {
        beatRef.current = 1;
        barRef.current += 1;
        if (barRef.current >= totalBars(currentSong)) {
          stop();
          setCurrentBeat(1);
          setCurrentBar(0);
          return;
        }
      } else {
        beatRef.current += 1;
      }
    }
    timerRef.current = setTimeout(schedule, 25);
  };

  const start = () => {
    if (!currentSong) return;
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.error("AudioContext error:", e);
        return;
      }
    }

    setIsPlaying(true);
    beatRef.current = 1;
    barRef.current = 0;
    setCurrentBeat(1);
    setCurrentBar(0);

    nextNoteTimeRef.current = audioContextRef.current.currentTime;
    schedule();
  };

  const stop = () => {
    setIsPlaying(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  useEffect(() => stop, []); // cleanup on unmount

  // ---------- Вспомогательные вычисления для визуализации ----------
  const ranges = currentSong
    ? (() => {
        let start = 0;
        return currentSong.sections.map(sec => {
          const end = start + (Number(sec.bars) || 0) - 1;
          const out = { start, end };
          start = end + 1;
          return out;
        });
      })()
    : [];

  const currentSectionIndex = ranges.findIndex(
    r => currentBar >= r.start && currentBar <= r.end
  );

  useEffect(() => {
    if (isPlaying && currentSectionRef.current) {
      currentSectionRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentBar, isPlaying]);

  // ---------- UI ----------
  if (!authReady) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-2">Metronome</div>
          <div className="opacity-70">Connecting…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-28 bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white p-6 flex flex-col items-center">
      <h1 className="text-3xl font-black mb-2">🎧 Metronome</h1>

      {/* Имя участника (локально, для "updatedBy") */}
      <div className="w-full max-w-xl mb-4">
        <input
          type="text"
          placeholder="Your name (for updates)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full p-3 rounded-xl bg-white/10 text-white placeholder-white/40"
        />
      </div>

      {/* SONG LIST */}
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
            <button onClick={createSong} className="w-full p-3 rounded-xl bg-green-600 font-bold">
              ➕ Add song
            </button>
          </div>

          {songs.map((song, i) => (
            <div
              key={song.id}
              className="flex gap-2 w-full max-w-xl mb-2"
              draggable
              onDragStart={songDragStart(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={songDrop(i)}
            >
              <span className="cursor-grab select-none text-white/50">↕</span>
              <button
                onClick={() => selectSong(song)}
                className="flex-1 p-3 bg-white/10 hover:bg-white/20 rounded-xl text-left"
              >
                🎵 {song.name}
                {song.updatedBy && (
                  <span className="block text-xs opacity-60 mt-1">
                    updated by {song.updatedBy}
                  </span>
                )}
              </button>
              <button onClick={() => deleteSong(song.id)} className="p-3 bg-red-600 rounded-xl">
                🗑
              </button>
            </div>
          ))}
        </>
      )}

      {/* SONG EDITOR */}
      {currentSong && (
        <div className="glass p-6 rounded-3xl w-full max-w-xl">
          <div className="flex justify-between mb-4 items-center">
            <h2 className="text-xl font-bold">{currentSong.name}</h2>
            <button onClick={() => { setCurrentSongId(null); stop(); }} className="px-3 py-2 bg-purple-600 rounded-lg">
              ← Back
            </button>
          </div>

          <div className="space-y-3 mb-6">
            {currentSong.sections.map((sec, i) => {
              const isIntro = !!sec.intro;
              const isCurrentSection = i === currentSectionIndex;
              const range = ranges[i];

              return (
                <div
                  key={i}
                  ref={isCurrentSection ? currentSectionRef : null}
                  draggable={!isIntro}
                  onDragStart={sectionDragStart(i)}
                  onDragOver={(e) => e.preventDefault()}
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

                  {/* Комментарий под прогрессом кликов */}
                  {sec.comment && (
                    <div className="text-white/90 font-bold text-lg mt-2">
                      {sec.comment}
                    </div>
                  )}

                  {/* CLICK GRID */}
                  <div className="grid grid-cols-4 gap-1">
                    {Array.from({ length: (Number(sec.bars) || 0) * 4 }).map((_, idx) => {
                      const barNum = range.start + Math.floor(idx / 4);
                      const localBeat = (idx % 4) + 1;
                      const absClick = barNum * 4 + (localBeat - 1);
                      const currentAbs = currentBar * 4 + currentBeat - 1;
                      const past = absClick < currentAbs;
                      const now = absClick === currentAbs;

                      return (
                        <div key={idx} className="h-4 relative rounded-sm border border-gray-700 bg-gray-800">
                          <div
                            className={`
                              absolute left-0 top-0 h-full transition-all duration-150
                              ${past ? "bg-green-400" : now ? "bg-yellow-400 drop-shadow-[0_0_12px_rgba(255,255,0,1)]" : ""}
                            `}
                            style={{
                              width: now ? `${(currentBeat / beatsPerBar) * 100}%` : past ? "100%" : "0%"
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* ADD SECTION — по клику раскрываем форму, как согласовано (Вариант A) */}
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

                <input
                  type="number"
                  value={newSection.bars}
                  onChange={(e) => setNewSection({ ...newSection, bars: +e.target.value })}
                  className="w-full px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20 text-center"
                  min={1}
                />

                <input
                  type="text"
                  placeholder="Comment (optional)"
                  value={newSection.comment}
                  onChange={(e) => setNewSection({ ...newSection, comment: e.target.value })}
                  className="w-full px-3 py-2 text-white bg-white/10 rounded-lg border border-white/20"
                />

                <div className="flex gap-3">
                  <button onClick={addSection} className="flex-1 py-2 bg-green-600 rounded-lg font-bold">
                    ✔ Save Section
                  </button>
                  <button onClick={() => setShowAddForm(false)} className="py-2 px-4 bg-gray-500 rounded-lg font-bold">
                    ✖
                  </button>
                </div>
              </div>
            )}
          </div>

          <label className="block opacity-80 mb-1">Tempo: {bpm} BPM</label>
          <input
            type="range"
            min="40"
            max="240"
            value={bpm}
            onChange={(e) => setBpm(+e.target.value)}
            className="w-full mb-2"
          />

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
    </div>
  );
}

ReactDOM.render(<App />, document.getElementById("root"));
