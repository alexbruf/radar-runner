/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        orange: { brand: "#fd5200", light: "#ff6b2c" },
      },
    },
  },
  plugins: [],
};
