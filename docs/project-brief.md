# SafariCash - Project Brief
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
- **Couleur signature** : Vert SafariCash (#1D9E75) - confiance, prospérité
- **Typographie** : System-ui pour lisibilité mobile optimale
- **Iconographie** : Émojis universels + SVG minimalistes
- **Layout** : Mobile-first, tab navigation, cards épurées

### Architecture des Écrans

#### 🏠 **Écrans Principaux** (navigation quotidienne)
1. **Dashboard** 
   - Stats temps réel (membres actifs, collecté aujourd'hui, commission)
   - Actions rapides (Cotisation, Prêt Express)
   - Activité récente avec horodatage

2. **Liste Membres**
   - Recherche instantanée (150+ membres)
   - Cards avec progress bars visuelles
   - Badges de statut (Actif, Terminé, Avance)
   - Bouton flottant "+" pour ajout

3. **Transaction Rapide**
   - Sélection membre + type d'opération
   - Montant suggéré automatique
   - Aperçu en temps réel des calculs

4. **Profil Membre**
   - Vue 360° : cotisé, attendu, avances, solde final
   - Historique chronologique complet
   - Actions contextuelles

#### ⚙️ **Gestion Membres** (CRUD complet)
5. **Ajout Membre**
   - Formulaire minimal : Nom + Téléphone + Cotisation
   - Prévisualisation automatique du cycle
   - Calculs transparents (total, commission, remboursement)

6. **Modification**
   - Édition sécurisée avec alertes d'impact
   - Zone de danger pour suppression
   - Redémarrage de cycle

7. **Prêt Express**
   - Situation membre en contexte
   - Suggestions rapides (50K, 100K, 150K)
   - Simulation impact sur solde final
   - Traçabilité motif

8. **Suppression Sécurisée**
   - Confirmation double obligatoire
   - Affichage données perdues
   - Saisie "SUPPRIMER" pour valider

### Responsive & Performance
- **PWA** installable (smartphone/tablette)
- **Offline-ready** avec synchronisation cloud
- **Touch-optimized** (44px minimum boutons)
- **Animations fluides** pour feedback utilisateur

---

## 🏗️ ARCHITECTURE (Technique)

### Stack Technologique Recommandé
```
Frontend : React 18 + TypeScript
Styling  : Tailwind CSS + Framer Motion
PWA      : Vite PWA Plugin
Database : Supabase (PostgreSQL + Auth + Storage)
Hosting  : Vercel (Edge deployment)
Mobile   : PWA installable (iOS/Android)
```

### Structure Base de Données
```sql
-- Collecteur
users (
  id, email, phone, name, 
  created_at, subscription_plan
)

-- Membres épargnants
members (
  id, user_id, name, phone, 
  daily_amount, cycle_start_date,
  status, created_at
)

-- Transactions
transactions (
  id, member_id, type, amount, 
  date, notes, receipt_url
)

-- Cycles d'épargne
cycles (
  id, member_id, start_date, end_date,
  total_expected, total_paid, total_loans,
  commission, final_balance, status
)
```

### APIs Essentielles
- **Authentification** : Magic links ou SMS OTP
- **Notifications** : SMS automatiques (Twilio/Termii)
- **Paiements** : Intégration Wave/Orange Money (future)
- **Reçus** : Génération PDF/WhatsApp
- **Backup** : Synchronisation cloud automatique

### Sécurité & Compliance
- **Chiffrement** données sensibles (montants, téléphones)
- **Audit trail** complet des modifications
- **Backup automatique** quotidien
- **RGPD** compliance (consentement, droit à l'oubli)
- **Rate limiting** pour éviter les abus

---

## 📊 DATA (Données)

### Métriques Business Critiques
1. **Nombre de membres actifs** (objectif : 150+)
2. **Volume quotidien collecté** (trend mensuel)
3. **Taux de complétion cycles** (% membres qui terminent)
4. **Montant moyen des prêts** (risque exposure)
5. **Commission générée** (revenus collecteur)

### Rapports Automatiques
- **Hebdomadaire** : Cycles se terminant, membres en retard
- **Mensuel** : Performance globale, top membres
- **Fin de cycle** : Récapitulatif membre + collecteur

### Analytics Utilisateur
- **Écrans les plus utilisés** (optimisation UX)
- **Temps de transaction** (efficacité workflow)
- **Erreurs fréquentes** (amélioration interface)
- **Adoption fonctionnalités** (priorisation dev)

### Données de Démonstration
```json
{
  "membres": [
    {
      "nom": "Fatou Diallo",
      "cotisation": 5000,
      "jour": 25,
      "total_cotise": 125000,
      "avances": 0,
      "solde_final": 145000,
      "statut": "actif"
    },
    {
      "nom": "Moussa Koné", 
      "cotisation": 10000,
      "jour": 18,
      "total_cotise": 180000,
      "avances": 50000,
      "solde_final": 240000,
      "statut": "avance"
    },
    {
      "nom": "Aminata Ba",
      "cotisation": 7500,
      "jour": 30,
      "total_cotise": 225000,
      "avances": 0,
      "solde_final": 217500,
      "statut": "terminé"
    }
  ]
}
```

### Intégrations Data
- **Export Excel** pour comptabilité externe
- **API WhatsApp Business** pour notifications
- **Webhooks** pour systèmes de paiement tiers
- **Google Sheets** sync pour backup/partage

---

## 🚀 PLAN DE DÉVELOPPEMENT

### Phase 1 - MVP (4-6 semaines)
**Fonctionnalités Core :**
- ✅ Authentification SMS/Email
- ✅ CRUD membres complet
- ✅ Enregistrement transactions (cotisations + prêts)
- ✅ Calculs automatiques des cycles
- ✅ Génération reçus simples
- ✅ Dashboard avec stats de base

### Phase 2 - Optimisation (2-3 semaines)
**Améliorations UX :**
- ✅ PWA installable
- ✅ Mode offline basique
- ✅ Notifications push
- ✅ Recherche avancée
- ✅ Export PDF des rapports

### Phase 3 - Scale (4-5 semaines)
**Fonctionnalités Avancées :**
- ✅ Multi-collecteur (équipes)
- ✅ Intégration paiements mobiles
- ✅ Analytics avancées
- ✅ API publique pour partenaires
- ✅ White-label pour banques/IMF

### Budget Estimé
```
Développement MVP    : 15 000 € - 20 000 €
Hébergement/An       : 500 € - 1 000 €
SMS/Notifications/An : 1 000 € - 2 000 €
Maintenance/Support  : 3 000 € - 5 000 €/an

Total Année 1 : 19 500 € - 28 000 €
```

### Métriques de Succès
- **6 mois** : 50+ collecteurs actifs
- **12 mois** : 500+ collecteurs, 25 000+ membres
- **18 mois** : Break-even financier
- **24 mois** : Expansion 3 pays (Sénégal, Côte d'Ivoire, Mali)

---

## 📞 ÉQUIPE & RESSOURCES

### Compétences Requises
- **1 Lead Developer** : React/TypeScript expert
- **1 UI/UX Designer** : Mobile-first, marchés émergents
- **1 Product Manager** : Connaisseur secteur financier informel
- **1 QA Engineer** : Tests automatisés, devices multiples

### Partenariats Stratégiques
- **Opérateurs mobiles** : Intégration SMS/USSD
- **Fintechs locales** : Wave, Orange Money, MTN
- **Incubateurs** : CTIC Dakar, Ecobank Fintech Challenge
- **Investisseurs** : Fonds impact, family offices

### Conformité Légale
- **Licence microfinance** ou partenariat IMF
- **Protection données** UEMOA
- **KYC/AML** basique pour collecteurs
- **Assurance** couverture cyber-risques

---

## ✅ PROCHAINES ÉTAPES

### Immédiat (1-2 semaines)
1. **Validation terrain** : Interviews 10+ collecteurs
2. **Prototypage** : Version cliquable Figma
3. **Architecture technique** : Choix stack définitif
4. **Partenariats** : Premier contact Wave/Orange Money

### Court terme (1-2 mois)
1. **Développement MVP** : Features core
2. **Beta testing** : 5-10 collecteurs pilotes
3. **Itération rapide** : Feedback utilisateurs
4. **Légal** : Structure juridique et conformité

### Moyen terme (3-6 mois)
1. **Lancement** commercial restreint
2. **Acquisition** premiers 50 collecteurs
3. **Product-market fit** : Métriques validation
4. **Levée de fonds** : Seed round 200-500K€

---

**SafariCash transforme un métier traditionnel en solution digitale moderne, créant de la valeur pour collecteurs ET épargnants. Le marché est immense, la solution concrète, l'opportunité unique.** 🦁💰