# Collectif

Collectif est un whiteboard privé accessible sur `collectif.rialet.fr`. Le projet utilise uniquement Node.js et ses modules intégrés, sans base de données ou paquet externe à installer.

## Fonctionnalités

- Connexion obligatoire avec un compte configuré côté serveur.
- Whiteboard privé avec notes, liens, images, captures d’écran et fichiers.
- Ajout par glisser-déposer ou sélection de fichiers, puis déplacement des éléments sur la toile.
- Aperçu des images, première page des PDF et aperçu textuel du début des documents DOCX.
- Création de liens de téléchargement protégés par un mot de passe choisi par le membre qui partage la ressource.
- Sélection multiple, suppression groupée et partage groupé dans une archive ZIP protégée par lien.
- Écran public de saisie du mot de passe; les mots de passe sont enregistrés sous forme hachée.
- Téléchargement des notes et des liens au format `.txt`.
- Révocation des liens et des liens associés à la suppression d’une ressource.
- Limite d’import réglable, à 25 Mo par défaut.

## Configuration

Utilisez Node.js 20 ou une version ultérieure. Copiez `.env.example` en `.env`, puis définissez un identifiant, un mot de passe unique d’au moins 12 caractères, le domaine public et le port. Le serveur refuse de démarrer tant que les identifiants valides ne sont pas renseignés.

```powershell
Copy-Item .env.example .env
```

Éditez ensuite `.env` :

```dotenv
COLLECTIF_USERNAME=mon-identifiant
COLLECTIF_PASSWORD=un-mot-de-passe-unique-de-plus-de-12-caracteres
APP_ORIGIN=https://collectif.rialet.fr
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
MAX_UPLOAD_MB=25
```

Démarrez l’application :

```powershell
npm start
```

Le serveur écoute sur `127.0.0.1:3000` par défaut. En production, faites pointer `collectif.rialet.fr` vers le serveur, activez HTTPS sur le reverse proxy et transférez les requêtes vers le port configuré. Conservez `APP_ORIGIN=https://collectif.rialet.fr` afin que les liens partagés utilisent le domaine public et que les cookies soient sécurisés. Si le reverse proxy se trouve dans un autre conteneur ou une autre machine, définissez `HOST=0.0.0.0` pour autoriser les connexions externes au processus.

Les métadonnées et fichiers sont enregistrés sous `data/` (ou `DATA_DIR`). Sauvegardez ce dossier avec le fichier `.env` dans votre procédure d’exploitation. Ne publiez pas `data/` sur le web.

## Fonctionnement du partage

Chaque lien utilise un jeton aléatoire non devinable. À la création, le membre saisit un mot de passe d’au moins 8 caractères. Collectif ne conserve que son empreinte salée. Le destinataire doit saisir ce mot de passe sur `/s/<jeton>` avant qu’un cookie de téléchargement temporaire lui soit délivré. Supprimer la ressource ou révoquer le lien bloque les futurs téléchargements.

