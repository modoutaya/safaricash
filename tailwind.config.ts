import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#F0FAF6",
          100: "#E1F5EE",
          200: "#C2EADC",
          300: "#94D9C0",
          400: "#5BC09D",
          500: "#1D9E75",
          600: "#16875F",
          700: "#085041",
          800: "#064236",
          900: "#053128",
          950: "#031E18",
          DEFAULT: "#1D9E75",
          foreground: "#FFFFFF",
        },
        warning: {
          DEFAULT: "#854F0B",
          bg: "#FAEEDA",
          text: "#633806",
          accent: "#854F0B",
          foreground: "#633806",
        },
        destructive: {
          DEFAULT: "#E24B4A",
          bg: "#FAECE7",
          text: "#712B13",
          accent: "#E24B4A",
          foreground: "#712B13",
        },
        info: {
          DEFAULT: "#0C447C",
          bg: "#E6F1FB",
          text: "#0C447C",
          accent: "#B5D4F4",
          foreground: "#0C447C",
        },
        surface: {
          0: "#F8F9F8",
          1: "#FFFFFF",
        },
        text: {
          primary: "#111111",
          secondary: "#666666",
          tertiary: "#AAAAAA",
        },
        hairline: "rgba(29,158,117,0.15)",
        border: "rgba(29,158,117,0.15)",
        input: "rgba(29,158,117,0.15)",
        ring: "#1D9E75",
        background: "#F8F9F8",
        foreground: "#111111",
        muted: {
          DEFAULT: "#F0FAF6",
          foreground: "#666666",
        },
        accent: {
          DEFAULT: "#E1F5EE",
          foreground: "#085041",
        },
        secondary: {
          DEFAULT: "#E1F5EE",
          foreground: "#085041",
        },
        card: {
          DEFAULT: "#FFFFFF",
          foreground: "#111111",
        },
        popover: {
          DEFAULT: "#FFFFFF",
          foreground: "#111111",
        },
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
      },
      fontSize: {
        display: ["24px", { lineHeight: "32px", fontWeight: "700" }],
        "title-1": ["20px", { lineHeight: "28px", fontWeight: "600" }],
        "title-2": ["16px", { lineHeight: "24px", fontWeight: "600" }],
        "body-1": ["15px", { lineHeight: "22px", fontWeight: "400" }],
        "body-2": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        caption: ["13px", { lineHeight: "18px", fontWeight: "500" }],
        overline: [
          "11px",
          {
            lineHeight: "16px",
            fontWeight: "600",
            letterSpacing: "0.08em",
          },
        ],
        "amount-large": ["32px", { lineHeight: "36px", fontWeight: "800" }],
        "amount-inline": ["15px", { lineHeight: "20px", fontWeight: "700" }],
      },
      spacing: {
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        5: "20px",
        6: "24px",
        7: "28px",
        8: "32px",
      },
      borderRadius: {
        sm: "8px",
        md: "12px",
        lg: "16px",
        full: "9999px",
      },
      boxShadow: {
        lift: "0 4px 12px rgba(29,158,117,0.12)",
        "cta-hover": "0 8px 20px rgba(29,158,117,0.3)",
        fab: "0 8px 20px rgba(29,158,117,0.4)",
        toast: "0 12px 30px rgba(29,158,117,0.4)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
