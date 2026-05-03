/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tokyo: {
          bg: "#1a1b26",
          panel: "#24283b",
          border: "#414868",
          text: "#c0caf5",
          cyan: "#7dcfff",
          purple: "#bb9af7",
          pink: "#f7768e",
          neon: "#ff007c",
        },
      },
      boxShadow: {
        neon: "0 0 28px rgba(187, 154, 247, 0.28)",
      },
    },
  },
  plugins: [],
};
