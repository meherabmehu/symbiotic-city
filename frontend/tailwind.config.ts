import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Extracted from the SYMBIOTIC CITY design: deep navy command surface,
        // cyan primary accent, mint success, amber caution, coral danger.
        navy: {
          950: "#040b18",
          900: "#061225",
          850: "#08182f",
          800: "#0b1e3a",
          750: "#0e2545",
          700: "#122c52",
          600: "#173a68",
          500: "#1e4a80",
        },
        ink: {
          50: "#f2f7fc",
          100: "#dce9f6",
          200: "#b9d2ea",
          300: "#8fb3d4",
          400: "#6b8fb3",
          500: "#4d6d8f",
        },
        accent: {
          DEFAULT: "#45d8f5",
          soft: "#7be7ff",
          deep: "#0ea5c4",
        },
        mint: "#3ee6a5",
        amber: "#ffb545",
        coral: "#ff6b6b",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        glass: "0 20px 60px -30px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255,255,255,0.06)",
        glow: "0 0 0 1px rgba(69, 216, 245, 0.35), 0 0 32px -6px rgba(69, 216, 245, 0.55)",
        card: "0 18px 40px -28px rgba(3, 10, 24, 0.95)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(circle at 20% 0%, rgba(69,216,245,0.14), transparent 45%), radial-gradient(circle at 85% 15%, rgba(62,230,165,0.10), transparent 40%)",
        "hero-glow":
          "radial-gradient(1200px 600px at 50% -10%, rgba(69,216,245,0.22), transparent 60%)",
      },
      keyframes: {
        "pulse-ring": {
          "0%": { opacity: "0.9", transform: "scale(0.85)" },
          "70%": { opacity: "0", transform: "scale(1.9)" },
          "100%": { opacity: "0", transform: "scale(1.9)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-up": "fade-up 0.35s ease-out both",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
