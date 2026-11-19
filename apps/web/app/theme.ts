import { createTheme } from "@mantine/core";

export const theme = createTheme({
  fontFamily: '"Geist", "Noto Sans KR", system-ui, sans-serif',
  primaryColor: "samtdi",
  primaryShade: 8,
  defaultRadius: "sm",
  colors: {
    samtdi: [
      "#eef8f0", "#deeee2", "#bbdcc3", "#96cba4", "#76ba87",
      "#5eab72", "#4c9d60", "#37894d", "#1a7138", "#11572b",
    ],
  },
});
