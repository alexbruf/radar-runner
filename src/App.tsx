import { useState, useCallback } from "react";
import { RadarRunner } from "./components/RadarRunner";

export default function App() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.classList.contains("dark"),
  );

  const toggleTheme = useCallback(() => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }, [isDark]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4 py-8 transition-colors"
      style={{ background: isDark ? "#292929" : "#f5f5f0" }}
    >
      <div className="text-center mb-6">
        <h1
          className="text-3xl font-semibold tracking-tight mb-1"
          style={{ color: isDark ? "rgba(255,255,255,0.87)" : "rgba(0,0,0,0.8)" }}
        >
          Radar Runner
        </h1>
        <p
          className="text-sm"
          style={{ color: isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.4)" }}
        >
          Dive into slopes, soar off hilltops, outrun the night.
        </p>
      </div>

      <RadarRunner isDark={isDark} />

      <button
        onClick={toggleTheme}
        className="mt-6 px-3 py-1 rounded text-xs cursor-pointer"
        style={{
          background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
          color: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)",
          border: `1px solid ${isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"}`,
        }}
      >
        {isDark ? "Light mode" : "Dark mode"}
      </button>
    </div>
  );
}
