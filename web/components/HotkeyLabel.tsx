// A glue button's caption with its hotkey picked out. The game writes the colour into the
// string itself — GlobalStrings.fdf `KEY_SINGLE_PLAYER "|CffffffffS|Ringle Player"` — so the
// shortcut letter is WHITE inside a gold caption (StandardButtonTextTemplate FontColor
// 0.99 0.827 0.0705). The first occurrence of the letter is the one that is marked.
export function HotkeyLabel({ text, hotkey }: { text: string; hotkey?: string }) {
  if (!hotkey) return <>{text}</>;
  const i = text.toLowerCase().indexOf(hotkey.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="hk">{text[i]}</span>
      {text.slice(i + 1)}
    </>
  );
}
