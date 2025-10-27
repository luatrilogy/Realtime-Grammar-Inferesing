window.addEventListener('load', () => {
    const imageUpload = document.getElementById('fileUpload');

    // getting libaries
    Promise.all([
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models')
    ]).then(start);

    async function start(){
        const body = document.body;
        body.append('Loaded');

        const conationer = document.createElement('div');
        conationer.className = 'conationer';
        conationer.style.position = 'relative';
        body.append(conationer);

        let image;
        let canvas;
        imageUpload.addEventListener('change', async () => {
            if(image) image.remove();
            if(canvas) canvas.remove();

            image = await faceapi.bufferToImage(imageUpload.files[0]);
            conationer.append(image);

            canvas = faceapi.createCanvasFromMedia(image);
            conationer.append(canvas);

            const displaySize = { width: image.width, height: image.height };
            faceapi.matchDimensions(canvas, displaySize);

            const detections = await faceapi.detectAllFaces(image).withFaceLandmarks().withFaceDescriptors();
            console.log(detections.length);

            const resziedDections = faceapi.resizeResults(detections, displaySize);
            resziedDections.forEach(detections => {
                const box = detections.detection.box;
                const drawBox = new faceapi.draw.DrawBox(box, {label: 'Face'});

                drawBox.draw(canvas);
            });
        })
    }
});

function loadLabeledImages(){
    const lables = ['Black Widow', 'Captin America', 'Captin Marvel', 'Hawkeye',
                    'Jim Rhodes', 'Thor', 'Tony Stark']

    return Promise.all([
        lables.map(async label => {
            const dections = []

            for(let i = 1; i <= 2; i++){
                const image = await faceapi.fetchImage(`https://github.com/WebDevSimplified/Face-Recognition-JavaScript/tree/master/labeled_images/${label}/${i}.jpg`)
                
                const detection = await faceapi.detectSingleFace(img).withFaceDescriptors()
                dections.push(detection.descriptor)
            }

            return new faceapi.LabeledFaceDescriptors(label, dections)
        })
    ])
}