/**
 * Traduit un refus de plan venue de la base en message affichable.
 *
 * Depuis que le verrou de plan est appliqué côté serveur, l'utilisateur peut
 * rencontrer le refus alors que l'écran lui-même est ouvert : un essai qui a
 * expiré, un plan rétrogradé, un onglet laissé ouvert depuis un changement
 * d'abonnement. Le message technique de PostgreSQL — « La fonctionnalité
 * « forecast » nécessite le plan pro (plan actuel : free). » — contient bien
 * l'information, mais il faut le dire autrement à un commerçant.
 *
 * Le message d'origine est conservé dans tous les cas : si la reconnaissance
 * échoue, on ne masque rien.
 */
export function readablePlanError(message: string): string {
  const m = /nécessite le plan (\w+) \(plan actuel : (\w+)\)/.exec(message);
  if (m) {
    const [, requis, actuel] = m;
    const nomRequis = requis === 'pro' ? 'Pro' : requis === 'starter' ? 'Starter' : requis;
    const nomActuel = actuel === 'pro' ? 'Pro' : actuel === 'starter' ? 'Starter' : 'Gratuit';

    if (requis === 'pro') {
      // Le plan actuel est nommé même ici : un Starter qui tombe sur ce mur doit
      // comprendre qu'il a déjà le palier précédent, sinon il ne sait pas si
      // l'obstacle est le produit ou son abonnement.
      return `Les prévisions de réapprovisionnement demandent le plan Pro — votre boutique est en plan ${nomActuel}. Le plan Pro indique combien de jours de stock il vous reste avant la rupture et quoi commander.`;
    }
    return `Cette fonctionnalité nécessite le plan ${nomRequis} — votre boutique est en plan ${nomActuel}. Passez au plan supérieur dans Paramètres pour y accéder.`;
  }

  if (/Fonctionnalité inconnue/.test(message)) return message;
  if (message === 'Non authentifié') return 'Session expirée, reconnectez-vous.';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return 'Connexion impossible. Vérifiez votre réseau et réessayez.';
  }
  return message;
}
