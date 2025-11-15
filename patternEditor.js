const { useMemo } = React;

const SAMPLES_BASE = "sound/Real Drum Kit";

const PATTERN_INSTRUMENTS = [
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

const PATTERN_STEPS = 16;

const createEmptyPattern = () => ({
  steps: PATTERN_STEPS,
  tracks: PATTERN_INSTRUMENTS.map(inst => ({
    id: inst.id,
    name: inst.label,
    color: inst.color,
    steps: Array(PATTERN_STEPS).fill(false),
  })),
});

function PatternEditor({
  songName,
  pattern,
  currentStep,
  onToggleStep,
  onClose,
  onClear,
}) {
  if (!pattern) return null;

  const headerCells = useMemo(
    () =>
      Array.from({ length: pattern.steps }).map((_, idx) => ({
        label: (idx + 1),
        idx,
      })),
    [pattern.steps]
  );

  const gridTemplate = {
    gridTemplateColumns: `100px repeat(${pattern.steps}, minmax(2.5rem, 1fr))`,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white p-4">
      <div className="max-w-4xl mx-auto glass rounded-3xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-black">🥁 Свой паттерн</h2>
            <p className="text-white/70 text-sm">{songName}</p>
          </div>
          <div className="flex gap-3">
            <button
              className="px-4 py-2 rounded-xl bg-white/10 border border-white/20"
              onClick={onClear}
            >
              Очистить
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-blue-600 font-bold"
              onClick={onClose}
            >
              Готово
            </button>
          </div>
        </div>

        <div className="overflow-auto">
          <div className="grid gap-2 items-center" style={gridTemplate}>
            <div />
            {headerCells.map(cell => (
              <div
                key={cell.idx}
                className="text-xs text-center opacity-70"
              >
                {cell.label}
              </div>
            ))}
            {pattern.tracks.map(track => (
              <React.Fragment key={track.id}>
                <div className="font-mono text-sm pr-2 text-right opacity-80">
                  {track.name}
                </div>
                {track.steps.map((active, idx) => {
                  const isCurrent = idx === currentStep;
                  return (
                    <button
                      key={idx}
                      className={`h-10 rounded-lg border border-white/10 transition
                        ${active ? "bg-white/40" : "bg-white/5"}
                        ${isCurrent ? "ring-2 ring-yellow-300" : ""}
                      `}
                      style={{ backgroundColor: active ? track.color : "rgba(255,255,255,0.05)" }}
                      onClick={() => onToggleStep(track.id, idx)}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(25px); }
      `}</style>
    </div>
  );
}

window.MetronomePattern = {
  PATTERN_INSTRUMENTS,
  PATTERN_STEPS,
  createEmptyPattern,
};

window.PatternEditor = PatternEditor;
