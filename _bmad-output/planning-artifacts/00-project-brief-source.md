# SafariCash — Project Brief (Source)

> Archived as provided by Mamadou on 2026-04-18. This is the canonical source input for all downstream planning artifacts (analysis, PRD, architecture, epics).

## 🦁 Système d'épargne personnelle pour collecteurs

---

## 📋 BUSINESS (Métier)

### Contexte Métier
SafariCash répond à un besoin spécifique du secteur informel en Afrique de l'Ouest : la **collecte d'épargne personnalisée**. Contrairement aux tontines traditionnelles où l'argent circule entre membres, SafariCash permet à un collecteur de gérer des **comptes individuels séparés** pour chaque épargnant.

### Modèle Économique
- **Client principal** : Collecteur professionnel (entrepreneur individuel)
- **Utilisateurs finaux** : 150+ membres épargnants (commerçants, artisans)
- **Cycle d'épargne** : 30 jours calendaires fixes
- **Rémunération** : 1 jour de cotisation = commission du collecteur
- **Service additionnel** : Prêts/avances sans intérêts (déductibles du solde final)

### Exemple Concret
**Membre : Fatou Diallo, commerçante**
- Cotisation : 5 000 FCFA/jour × 30 jours = 150 000 FCFA
- Commission collecteur : 5 000 FCFA
- Prêt en cours de cycle : 50 000 FCFA (urgence familiale)
- **Solde final** : 150 000 - 5 000 - 50 000 = **95 000 FCFA remboursés**

### Objectifs Business
1. **Digitaliser** un métier traditionnellement géré sur papier
2. **Sécuriser** les calculs et éviter les erreurs humaines
3. **Professionnaliser** l'image du collecteur avec reçus électroniques
4. **Augmenter** la capacité de gestion (150+ membres vs 50 actuels)
5. **Traçabilité** complète pour confiance client et conformité

---

## 🎨 MOCKUP (Interface)

### Design System
- **Couleur signature** : Vert SafariCash (#1D9E75)
- **Typographie** : System-ui
- **Iconographie** : Émojis universels + SVG minimalistes
- **Layout** : Mobile-first, tab navigation, cards épurées

### Architecture des Écrans
1. **Dashboard** — stats temps réel, actions rapides, activité récente
2. **Liste Membres** — recherche instantanée, cards + progress bars, badges statut, FAB "+"
3. **Transaction Rapide** — sélection membre/type, montant suggéré, aperçu calculs
4. **Profil Membre** — vue 360°, historique chronologique, actions contextuelles
5. **Ajout Membre** — formulaire minimal, prévisualisation cycle
6. **Modification** — édition sécurisée, zone danger, redémarrage cycle
7. **Prêt Express** — contexte membre, suggestions rapides, simulation impact
8. **Suppression Sécurisée** — double confirmation, saisie "SUPPRIMER"

### Responsive & Performance
- PWA installable, offline-ready, touch-optimized (44px), animations fluides

---

## 🏗️ ARCHITECTURE (Technique)

### Stack Recommandé
- Frontend: React 18 + TypeScript
- Styling: Tailwind CSS + Framer Motion
- PWA: Vite PWA Plugin
- Database: Supabase (PostgreSQL + Auth + Storage)
- Hosting: Vercel
- Mobile: PWA installable

### Structure Base de Données (extrait)
- `users` (collecteurs)
- `members` (épargnants)
- `transactions`
- `cycles`

### APIs Essentielles
- Auth (magic links / SMS OTP)
- Notifications SMS (Twilio/Termii)
- Paiements (Wave/Orange Money — futur)
- Génération reçus PDF/WhatsApp
- Backup cloud

### Sécurité & Compliance
- Chiffrement données sensibles, audit trail, backup quotidien, RGPD, rate limiting

---

## 📊 DATA

### Métriques Business Critiques
1. Membres actifs (objectif 150+)
2. Volume quotidien collecté
3. Taux complétion cycles
4. Montant moyen prêts
5. Commission générée

### Rapports Automatiques
- Hebdo: cycles finissants, membres en retard
- Mensuel: performance, top membres
- Fin de cycle: récap membre + collecteur

### Jeu de Données Démo
Fatou Diallo (5000/j, jour 25), Moussa Koné (10000/j, jour 18, 50K avance), Aminata Ba (7500/j, jour 30, terminé).

### Intégrations
- Export Excel, WhatsApp Business, Webhooks paiement, Google Sheets sync

---

## 🚀 PLAN DE DÉVELOPPEMENT

### Phase 1 — MVP (4-6 semaines)
Auth, CRUD membres, transactions, calculs cycle, reçus, dashboard.

### Phase 2 — Optimisation (2-3 semaines)
PWA, offline, push, recherche avancée, export PDF.

### Phase 3 — Scale (4-5 semaines)
Multi-collecteur, paiements mobiles, analytics, API publique, white-label.

### Budget
- Dev MVP: 15-20 k€
- Hébergement/an: 500-1000 €
- SMS/notif/an: 1-2 k€
- Maintenance/an: 3-5 k€
- **Total an 1: 19,5-28 k€**

### Métriques de Succès
- 6 mois: 50+ collecteurs
- 12 mois: 500+ collecteurs, 25 000+ membres
- 18 mois: break-even
- 24 mois: expansion Sénégal / Côte d'Ivoire / Mali

---

## 📞 ÉQUIPE & PARTENARIATS
- 1 Lead Dev React/TS, 1 UI/UX, 1 PM fintech informel, 1 QA
- Partenariats: opérateurs mobiles, Wave/Orange Money/MTN, incubateurs (CTIC Dakar, Ecobank), investisseurs impact

### Conformité Légale
- Licence microfinance ou partenariat IMF
- Protection données UEMOA, KYC/AML, assurance cyber

---

## ✅ PROCHAINES ÉTAPES
- Immédiat: interviews terrain 10+ collecteurs, prototype Figma, stack, premier contact Wave/OM
- Court terme: dev MVP, beta 5-10 collecteurs, itération, juridique
- Moyen terme: lancement restreint, 50 collecteurs, PMF, seed 200-500 k€
