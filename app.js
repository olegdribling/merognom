// ✅ FULL UPDATED FILE — Group code gate + realtime Firestore sync
const { useState, useRef, useEffect } = React;

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
    const saved = localStorage.getItem('songs_final2');
    return saved ? JSON.parse(saved) : [];
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

  const beatsPerBar = 4;
  const audioContextRef = useRef(null);
  const timerRef = useRef(null);
  const nextNoteTimeRef = useRef(0);
  const beatRef = useRef(1);
  const barRef = useRef(0);
  const currentSectionRef = useRef(null);

  const totalBars = song => song ? song.sections.reduce((s, sec) => s + sec.bars, 0) : 0;

  // ====== FIRESTORE REALTIME SYNC ======
  // Слушатель облака (включается только при верном коде)
  useEffect(() => {
    if (bandCode !== CORRECT_CODE) return;
    const docRef = db.collection("bands").doc(bandCode);

    const unsub = docRef.onSnapshot((doc) => {
      const data = doc.data();
      if (data && Array.isArray(data.songs)) {
        setSongs(data.songs);
        localStorage.setItem("songs_final2", JSON.stringify(data.songs));
        // если текущая песня пропала — сбросим выбор
        if (currentSong && !data.songs.find(s => s.id === currentSong.id)) {
          setCurrentSong(null);
        }
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
    setSongs(updatedSongs);
    localStorage.setItem("songs_final2", JSON.stringify(updatedSongs));

    if (bandCode === CORRECT_CODE) {
      try {
        await db.collection("bands").doc(bandCode).set({
          songs: updatedSongs,
          updatedAt: serverTimestamp()
        });
      } catch (e) {
        console.warn("Cloud save failed:", e);
      }
    }

    if (updated) {
      setCurrentSong(updatedSongs.find(s => s.id === updated.id));
    }
  };

  const createSong = () => {
    if (!newSongName.trim()) return;
    const song = {
      id: Date.now(),
      name: newSongName.trim(),
      sections: [
        { name: "1 2 3 4", bars: 2, intro: true }
      ]
    };
    save([...songs, song]);
    setNewSongName("");
  };

  const selectSong = (song) => {
    stop();
    setCurrentSong(song);
    setCurrentBeat(1);
    setCurrentBar(0);
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
    gain.gain.value = accent ? 1 : 0.55;

    osc.start(time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
    osc.stop(time + 0.08);
  };

  
//  ТАЙМЕРЫ КЛИКОВ И ИХ СИНХРОНИЗАЦИЯ
  
const visualTimersRef = useRef([]); // добавь этот ref в начало компонента

const schedule = () => {
  const ct = audioContextRef.current.currentTime;
  const lookahead = 0.1;
  
  while (nextNoteTimeRef.current < ct + lookahead) {
    const scheduledTime = nextNoteTimeRef.current;
    const currentBeatValue = beatRef.current;
    const currentBarValue = barRef.current;
    
    // Рассчитываем задержку для визуала (синхронно со звуком)
    const visualDelay = Math.max(0, (scheduledTime - ct) * 1000);
    
    // Обновляем визуал с той же задержкой, что и звук
    const timerId = setTimeout(() => {
      setCurrentBeat(currentBeatValue);
      setCurrentBar(currentBarValue);
    }, visualDelay);
    
    visualTimersRef.current.push(timerId); // сохраняем ID таймера
    
    // Планируем звук
    clickSound(scheduledTime, currentBeatValue === 1);

    nextNoteTimeRef.current += 60 / bpm;

    if (beatRef.current === beatsPerBar) {
      beatRef.current = 1;
      barRef.current += 1;
      if (barRef.current >= totalBars(currentSong)) {
        setTimeout(() => {
          stop();
          setCurrentBeat(1);
          setCurrentBar(0);
        }, visualDelay);
        return;
      }
    } else beatRef.current += 1;
  }
  timerRef.current = setTimeout(schedule, 25);
};

  //  КОНЕЦ

  const start = () => {
    if (!currentSong) return;
    if (!audioContextRef.current)
      audioContextRef.current = new AudioContext();
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
  
  // Очищаем все визуальные таймеры
  visualTimersRef.current.forEach(id => clearTimeout(id));
  visualTimersRef.current = [];
};

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

  // ====== UI RENDER ======
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

      <div className="mb-4 opacity-70 text-sm">
        Группа: <span className="font-mono bg-white/10 px-2 py-1 rounded">0000</span>
        <button className="ml-3 text-red-300 underline" onClick={resetCode}>сменить код</button>
      </div>

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

                 <div className="grid grid-cols-4 gap-1">
  {Array.from({ length: sec.bars * 4 }).map((_, idx) => {
    const barNum = range.start + Math.floor(idx / 4);
    const localBeat = (idx % 4) + 1;
    const absClick = barNum * 4 + (localBeat - 1);
    const currentAbs = currentBar * 4 + currentBeat - 1;
    const isPassed = absClick < currentAbs;
    const isFirstBeat = localBeat === 1;

    return (
      <div 
        key={idx} 
        className={`
          h-5 rounded-md transition-all duration-100
          ${isPassed 
            ? 'bg-green-500/70' 
            : isFirstBeat 
              ? 'bg-white/30 border-2 border-white/50' 
              : 'bg-white/15'
          }
        `}
      />
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

      <style>{`
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(15px); }
      `}</style>
    </div>
  );
}

ReactDOM.render(<App />, document.getElementById("root"));
