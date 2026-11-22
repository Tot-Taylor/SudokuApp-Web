import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('The app root is missing.');
}

createRoot(root).render(<App />);
