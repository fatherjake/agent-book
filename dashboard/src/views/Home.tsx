import { ChartsSection } from './Charts';
import { ExperimentsSection } from './Experiments';

/** Home: charts on top, the experiment table underneath. */
export function HomeView() {
  return (
    <>
      <ChartsSection />
      <ExperimentsSection />
    </>
  );
}
