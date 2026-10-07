/**
 * Mode hubs: the screen opened from the main menu for each mode, and the full stack restored when returning
 * from a session (MenuSystem.showHome / results "繼續").
 */
import type { MenuHome } from '../../meta/context';
import { loadCareer, loadMyTeam } from '../../meta/save';
import type { Host, Screen } from './screen';
import { CareerHubScreen } from './screens/careerHub';
import { CareerWizardScreen } from './screens/careerWizard';
import { grandPrixEntry, grandPrixStack } from './screens/grandPrix';
import { MyTeamHubScreen } from './screens/myTeamHub';
import { MyTeamWizardScreen } from './screens/myTeamWizard';
import { SplitScreenSetupScreen } from './screens/splitScreen';
import { StoryScreen } from './screens/story';
import { TimeTrialScreen } from './screens/timeTrial';

/** First screen of a mode (main-menu entry). `main` falls back to the Grand Prix entry. */
export function entryScreen(host: Host, home: MenuHome): Screen {
  switch (home) {
    case 'timeTrial':
      return new TimeTrialScreen(host);
    case 'career':
      return loadCareer() ? new CareerHubScreen(host) : new CareerWizardScreen(host);
    case 'myTeam':
      return loadMyTeam() ? new MyTeamHubScreen(host) : new MyTeamWizardScreen(host);
    case 'story':
      return new StoryScreen(host);
    case 'splitScreen':
      return new SplitScreenSetupScreen(host);
    case 'grandPrix':
    case 'main':
      return grandPrixEntry(host);
  }
}

/** Screens stacked above the main menu when returning to a hub (empty for the main menu itself). */
export function hubScreens(host: Host, home: MenuHome): Screen[] {
  if (home === 'main') return [];
  if (home === 'grandPrix') return grandPrixStack(host);
  return [entryScreen(host, home)];
}
