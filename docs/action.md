# Vigía GitHub Action — Guía Oficial de Integración CI/CD

**Vigía** es una GitHub Action diseñada para detectar pruebas que pasan en verde sin verificar nada (pruebas tautológicas, aserciones huérfanas, bloques `expect` sin matcher, aserciones en bloques `catch` sin protección, etc.).

Además de publicar un reporte en formato Markdown como comentario en los Pull Requests, Vigía cuenta con **soporte nativo para OASIS SARIF v2.1.0** y publicación directa en **GitHub Code Scanning** mediante `@github/codeql-action/upload-sarif`.

---

## Índice

1. [Permisos requeridos en GitHub Actions](#permisos-requeridos-en-github-actions)
2. [Referencia de Inputs y Outputs](#referencia-de-inputs-y-outputs)
3. [Integración paso a paso con Jest](#integración-paso-a-paso-con-jest)
4. [Integración paso a paso con Vitest](#integración-paso-a-paso-con-vitest)
5. [Configuraciones avanzadas](#configuraciones-avanzadas)
   - [Monorepos y Matrices de CI (Uso de `category`)](#monorepos-y-matrices-de-ci-uso-de-category)
   - [Auditoría programada nocturna (Scheduled Scans)](#auditoría-programada-nocturna-scheduled-scans)
6. [Visualización en GitHub Code Scanning](#visualización-en-github-code-scanning)
7. [Preguntas Frecuentes y Solución de Problemas](#preguntas-frecuentes-y-solución-de-problemas)

---

## Permisos requeridos en GitHub Actions

Para aprovechar al máximo Vigía (comentarios en PR y alertas en la pestaña de Seguridad), configura los siguientes permisos en tu job o workflow:

```yaml
permissions:
  contents: read           # Para clonar el repositorio e inspeccionar el código
  pull-requests: write     # Para publicar el comentario interactivo en el PR
  security-events: write   # Para publicar el reporte SARIF en GitHub Code Scanning
```

> **Nota:** Si tu repositorio es público, GitHub Code Scanning es gratuito e ilimitado. En repositorios privados requiere GitHub Advanced Security habilitado. Si `security-events: write` no está disponible (por ejemplo, en PRs provenientes de forks externos), la subida de SARIF fallará de forma controlada (`continue-on-error: true`) sin abortar el resto del pipeline.

---

## Referencia de Inputs y Outputs

### Inputs

| Input | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `path` | `string` | `.` | Directorio o patrón a analizar cuando no está limitado a los archivos modificados. |
| `changed-only` | `boolean` | `true` | Analiza únicamente los archivos de prueba modificados en el Pull Request (`true`) o el proyecto completo (`false`). |
| `source` | `string` | `""` | Ruta raíz del código fuente (e.g. `src`). Habilita la detección de aserciones negativas huérfanas contra `testID` / `data-testid`. |
| `fail-on-p1` | `boolean` | `true` | Falla el job si se detectan hallazgos de severidad P1 (bloqueantes). |
| `comment` | `boolean` | `true` | Publica o actualiza el reporte como comentario fijo en el Pull Request. |
| `sarif` | `boolean` | `true` | Genera el archivo SARIF estándar OASIS v2.1.0. |
| `sarif-file` | `string` | `vigia-results.sarif` | Ruta de salida donde se guardará el archivo SARIF generado. |
| `upload-sarif` | `boolean` | `true` | Sube automáticamente el reporte SARIF a GitHub Code Scanning vía `@github/codeql-action/upload-sarif`. |
| `category` | `string` | `vigia` | Identificador de categoría en Code Scanning para desambiguar ejecuciones en matrices. |

### Outputs

| Output | Descripción |
|---|---|
| `findings` | Número total de hallazgos detectados (P1, P2 y P3). |
| `p1` | Número total de hallazgos de severidad crítica P1. |
| `sarif-file` | Ruta absoluta/relativa del reporte SARIF generado. |

---

## Integración paso a paso con Jest

Jest es el estándar clásico para pruebas en Node.js y React. A continuación se muestra un workflow completo que ejecuta los tests de Jest y vigila la calidad de las aserciones:

```yaml
# .github/workflows/jest-ci.yml
name: Jest Test & Vigía Security Scan

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: jest-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test-and-guard:
    name: Jest Suite & Vigía Code Scanning
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Necesario para que Vigía calcule diffs precisos en PRs

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run Jest Test Suite
        run: npm test -- --coverage

      - name: Run Vigía Assertion Guard
        uses: eduardo-mr1/vigia@v1
        with:
          source: 'src'
          changed-only: 'true'
          sarif: 'true'
          upload-sarif: 'true'
          fail-on-p1: 'true'
```

---

## Integración paso a paso con Vitest

Vitest ofrece velocidad extrema con ESM nativo. Vigía analiza directamente el árbol de sintaxis de TypeScript y JavaScript, haciéndolo 100% compatible con Vitest:

```yaml
# .github/workflows/vitest-ci.yml
name: Vitest & Vigía Guard

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: vitest-${{ github.ref }}
  cancel-in-progress: true

jobs:
  vitest-scan:
    name: Vitest & Security Scanning
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run Vitest Suite
        run: npx vitest run --coverage

      - name: Run Vigía Assertion Guard
        uses: eduardo-mr1/vigia@v1
        with:
          path: 'src'
          source: 'src'
          changed-only: 'true'
          sarif: 'true'
          upload-sarif: 'true'
          category: 'vitest-suite'
          fail-on-p1: 'true'
```

---

## Configuraciones avanzadas

### Monorepos y Matrices de CI (Uso de `category`)

En monorepos (Turborepo, Nx, pnpm workspaces), puedes ejecutar Vigía en paralelo para cada paquete asignando una categoría única en `category`:

```yaml
# .github/workflows/monorepo.yml
name: Monorepo CI

on:
  pull_request:

jobs:
  vigia-matrix:
    name: Vigía (${{ matrix.package }})
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      security-events: write
    strategy:
      matrix:
        package: [frontend, backend, shared]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: eduardo-mr1/vigia@v1
        with:
          path: packages/${{ matrix.package }}
          source: packages/${{ matrix.package }}/src
          changed-only: 'false'
          category: package-${{ matrix.package }}
```

### Auditoría programada nocturna (Scheduled Scans)

Para mantener auditada la totalidad del repositorio sin depender de un PR activo:

```yaml
# .github/workflows/vigia-nightly.yml
name: Vigía Nightly Audit

on:
  schedule:
    - cron: '0 3 * * *' # Todos los días a las 03:00 UTC
  workflow_dispatch:

jobs:
  full-audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4

      - uses: eduardo-mr1/vigia@v1
        with:
          path: '.'
          source: 'src'
          changed-only: 'false'
          comment: 'false'
          sarif: 'true'
          upload-sarif: 'true'
          fail-on-p1: 'false' # Auditoría informativa, no bloquea el cron
```

---

## Visualización en GitHub Code Scanning

Cuando `upload-sarif: 'true'` está activado, Vigía envía el informe a GitHub Security. 

### Correspondencia de severidades:
- **P1 (Bloqueante)** $\rightarrow$ `error`: Fallos críticos que invalidan la prueba (tautologías, falta de `await`, aserciones en `catch`, pruebas vacías).
- **P2 (Advertencia)** $\rightarrow$ `warning`: Aserciones huérfanas potenciales o expresiones idénticas.
- **P3 (Informativo)** $\rightarrow$ `note`: Pruebas ignoradas (`it.skip`), recordatorios de mantenimiento.

### Dónde ver los resultados:
1. Dirígete a la pestaña **Security** en la barra superior de tu repositorio.
2. En el menú lateral izquierdo, haz clic en **Code scanning alerts**.
3. Selecciona la herramienta **vigia** en el filtro para ver cada alerta detallada con su línea exacta, regla infringida y recomendación de solución.
4. En los Pull Requests, las alertas aparecen anotadas directamente en la pestaña **Files changed** sobre las líneas de código correspondientes.

---

## Preguntas Frecuentes y Solución de Problemas

### 1. `Resource not accessible by integration` al subir SARIF
Si el paso `Upload SARIF report to GitHub Code Scanning` falla con este mensaje, asegúrate de haber declarado en tu job:
```yaml
permissions:
  security-events: write
```

### 2. ¿Cómo funciona en Pull Requests desde Forks externos?
En repositorios públicos, los workflows ejecutados desde forks tienen permisos de solo lectura por seguridad de GitHub. Vigía tiene configurado `continue-on-error: true` en el paso de subida de SARIF para evitar que el job falle por limitaciones de permisos de forks externos.

### 3. ¿Cómo desactivar la subida automática si ya uso mi propio paso de upload-sarif?
Puedes poner `upload-sarif: 'false'` y usar el output `sarif-file` en un paso posterior de tu workflow:
```yaml
- uses: eduardo-mr1/vigia@v1
  id: vigia
  with:
    sarif: 'true'
    upload-sarif: 'false'

- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ${{ steps.vigia.outputs.sarif-file }}
```
