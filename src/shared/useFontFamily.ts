import { useEffect, useState } from "react";
import type { FontFamilyPreference } from "./api/types";
import { applyFontFamily, loadBundledFont } from "./fonts";

export function useFontFamily(preference: FontFamilyPreference) {
  const [effective, setEffective] = useState<FontFamilyPreference>("default");
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    function apply(value: FontFamilyPreference) {
      applyFontFamily(value);
      setEffective(value);
    }
    setLoadFailed(false);
    if (preference !== "jetBrainsMono") apply(preference);
    else {
      apply("default");
      void loadBundledFont().then(() => {
        if (active) apply(preference);
      }).catch(() => {
        if (active) setLoadFailed(true);
      });
    }
    return () => { active = false; };
  }, [preference]);
  return { effective, loadFailed };
}
