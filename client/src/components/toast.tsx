import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

type Toast = { id: number; text: string; error?: boolean };
let push: (t: Omit<Toast, 'id'>) => void = () => {};
let seq = 0;

export const toast = (text: string) => push({ text });
export const toastError = (e: unknown) => push({ text: e instanceof Error ? e.message : String(e), error: true });

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    push = (t) => {
      const id = ++seq;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.error ? 5000 : 2600);
    };
  }, []);
  return (
    <div className="toast-wrap">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} className={`toast ${t.error ? 'err' : ''}`}
            initial={{ opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}>
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
