
/**
 * these calculations could definitely be improved and updates are welcomed!
 *
 * for some detail explanation about the Open Pose model
 * and how to estimate human poses take a look at:
 *
 * https://arvrjourney.com/human-pose-estimation-using-openpose-with-tensorflow-part-1-7dd4ca5c8027
 * https://arvrjourney.com/human-pose-estimation-using-openpose-with-tensorflow-part-2-e78ab9104fc8
 */

const HeatMapCount = 19
const PafMapCount = 38
const MaxPairCount = 17

let NMSWindowSize = 6
let NMSThreshold = 0.001
let LocalPAFThreshold = 0.141
let PartScoreThreshold = 0.247
let PAFCountThreshold = 4

const PartCountThreshold = 4
const DIMFACTOR = 8

let cocoPairs = []
let cocoPairsNetwork = []
let cocoParts = []

window.estimatePoses = function (prediction, cocoUtil) {
  cocoPairs = cocoUtil.cocoPairs
  cocoPairsNetwork = cocoUtil.cocoPairsNetwork
  cocoParts = cocoUtil.cocoParts

  // split the prediction into the heatmap and pafmap arrays
  let [heatmaps, pafmaps] = prediction.unstack()[0].split([HeatMapCount, PafMapCount], 2)
  heatmaps = heatmaps.bufferSync()
  pafmaps = pafmaps.bufferSync()

  // compute possible parts candidates
  let partCandidates = computeParts(heatmaps)
  // compute possible pairs candidates
  let pairCandidates = computePairs(pafmaps, partCandidates)
  // compute possible poses
  let poseCandidates = computePoses(partCandidates, pairCandidates)

  // create the JSON response (with bodyParts, poseLines, etc)
  return formatResponse(poseCandidates)
}

const computeParts = function (heatmap) {
  let height = heatmap.shape[0]
  let width = heatmap.shape[1]
  let depth = heatmap.shape[2] - 1
  let parts = new Array(depth)

  // extract peak parts from heatmap
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      for (var d = 0; d < depth; d++) {
        if (!parts[d]) {
          parts[d] = []
        }
        const score = heatmap.get(y, x, d)
        if (score > NMSThreshold && isMaximum(score, y, x, d, heatmap)) {
          parts[d].push([y, x, score])
        }
      }
    }
  }

  return parts
}

const isMaximum = function (score, y, x, d, heatmap) {
  let isMax = true
  let height = heatmap.shape[0]
  let width = heatmap.shape[1]

  const h1 = Math.max(0, y - NMSWindowSize)
  const h2 = Math.min(height - 1, y + NMSWindowSize)
  const w1 = Math.max(0, x - NMSWindowSize)
  const w2 = Math.min(width - 1, x + NMSWindowSize)

  for (var h = h1; h <= h2; h++) {
    for (var w = w1; w <= w2; w++) {
      if (score < heatmap.get(h, w, d)) {
        isMax = false
        break
      }
    }
    if (!isMax) {
      break
    }
  }

  return isMax
}

const computePairs = function (pafmap, parts) {
  let pairsFinal = new Array(MaxPairCount)
  let pairs = new Array(MaxPairCount)

  cocoPairs.forEach((cocopair, i) => {
    let part1 = parts[cocopair[0]]
    let part2 = parts[cocopair[1]]

    pairs[i] = []
    pairsFinal[i] = []

    // connect the parts, score the connection, and find best matching connections
    for (var p1 = 0; p1 < part1.length; p1++) {
      for (var p2 = 0; p2 < part2.length; p2++) {
        let val = getScore(part1[p1][1], part1[p1][0], part2[p2][1], part2[p2][0], pafmap, cocoPairsNetwork[i])
        let score = val.score
        let count = val.count

        if (score > PartScoreThreshold && count >= PAFCountThreshold) {
          let inserted = false

          for (var l = 0; l < MaxPairCount; l++) {
            if (pairs[i][l] && score > pairs[i][l][2]) {
              pairs[i].splice(l, 0, [p1, p2, score])
              inserted = true
              break
            }
          }

          if (!inserted) {
            pairs[i].push([p1, p2, score])
          }
        }
      }
    }

    let added = {}
    for (var m = 0; m < pairs[i].length; m++) {
      let p = pairs[i][m]
      if (!added[`${p[0]}`] && !added[`${p[1]}`]) {
        pairsFinal[i].push(p)
        added[`${p[0]}`] = 1
        added[`${p[1]}`] = 1
      }
    }
  })

  return pairsFinal
}

const getScore = function (x1, y1, x2, y2, pafmap, cpnetwork) {
  let count = 0
  let score = 0

  let dx = x2 - x1
  let dy = y2 - y1
  let normVec = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2))

  if (normVec >= 0.0001) {
    const shape = pafmap.shape
    let vx = dx / normVec
    let vy = dy / normVec

    for (var t = 0; t < 10; t++) {
      let tx = Math.round(x1 + (t * dx / 9) + 0.5)
      let ty = Math.round(y1 + (t * dy / 9) + 0.5)

      if (shape[0] > ty && shape[1] > tx) {
        let s = vy * pafmap.get(ty, tx, cpnetwork[1]) +
                vx * pafmap.get(ty, tx, cpnetwork[0])

        if (s > LocalPAFThreshold) {
          count++
          score += s
        }
      }
    }
  }

  return {
    score: score,
    count: count
  }
}

const computePoses = function (parts, pairs) {
  let humans = []

  cocoPairs.forEach((cocopair, i) => {
    let p1 = cocopair[0]
    let p2 = cocopair[1]

    pairs[i].forEach((pair, j) => {
      let ip1 = pair[0]
      let ip2 = pair[1]
      let merged = false

      // calculate possible bodies from all pairs found
      for (var k = 0; k < humans.length; k++) {
        let human = humans[k]
        if (ip1 === human.coordsIndexSet[p1] || ip2 === human.coordsIndexSet[p2]) {
          human.coordsIndexSet[p1] = ip1
          human.coordsIndexSet[p2] = ip2

          human.partsList[p1] = partsJSON(p1, parts[p1][ip1])
          human.partsList[p2] = partsJSON(p2, parts[p2][ip2])

          merged = true
          break
        }
      }

      if (!merged) {
        let human = {
          partsList: new Array(18),
          coordsIndexSet: new Array(18)
        }

        human.coordsIndexSet[p1] = ip1
        human.coordsIndexSet[p2] = ip2

        human.partsList[p1] = partsJSON(p1, parts[p1][ip1])
        human.partsList[p2] = partsJSON(p2, parts[p2][ip2])

        humans.push(human)
      }
    })
  })

  return humans
}

const partsJSON = function (id, coords) {
  return {
    x: coords[1] ? coords[1] * DIMFACTOR : coords[1],
    y: coords[0] ? coords[0] * DIMFACTOR : coords[0],
    partName: cocoParts[id],
    partId: id,
    score: coords[2]
  }
}

const formatResponse = function (humans) {
  let humansFinal = []

  for (var i = 0; i < humans.length; i++) {
    let bodyPartCount = 0

    for (let j = 0; j < HeatMapCount - 1; j++) {
      if (humans[i].coordsIndexSet[j]) {
        bodyPartCount += 1
      }
    }

    // only include poses with enough parts
    if (bodyPartCount > PartCountThreshold) {
      let pList = humans[i].partsList
      let poseLines = []

      let cocoPairsRender = cocoPairs.slice(0, cocoPairs.length - 2)
      cocoPairsRender.forEach((pair, idx) => {
        if (pList[pair[0]] && pList[pair[1]]) {
          poseLines.push([pList[pair[0]].x, pList[pair[0]].y, pList[pair[1]].x, pList[pair[1]].y])
        }
      })

      humansFinal.push({
        'humanId': i,
        'bodyParts': pList,
        'poseLines': poseLines
      })
    }
  }

  return humansFinal
}
